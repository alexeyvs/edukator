"""Тонкая обёртка над закрытым мобильным API Microsoft Family Safety."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .config import ControllerConfig


class MicrosoftFamilyClient:
    def __init__(self, auth: Any, family: Any, child_user_id: str, block_days: int) -> None:
        self._auth = auth
        self._family = family
        self._child_user_id = child_user_id
        self._block_days = block_days

    @classmethod
    async def create(cls, config: ControllerConfig) -> MicrosoftFamilyClient:
        # Импорт намеренно ленивый: тесты автомата не требуют сетевой библиотеки.
        from pyfamilysafety import Authenticator, FamilySafety

        auth = await Authenticator.create(
            token=config.refresh_token,
            use_refresh_token=True,
        )
        family = FamilySafety(auth)
        # Не обращаемся к нестабильному aggregator во время запуска. Первая
        # сверка выполняется в основном цикле, где уже есть backoff и повторы.
        return cls(auth, family, config.child_user_id, config.block_days)

    @property
    def refresh_token(self) -> str:
        return self._auth.refresh_token

    def _account(self) -> Any:
        matches = [
            account for account in self._family.accounts
            if str(account.user_id) == self._child_user_id
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"Участник Family Safety с ID {self._child_user_id} не найден"
            )
        return matches[0]

    async def refresh(self) -> None:
        # FamilySafety.update() загружает отчёты, приложения и баланс для всех
        # участников (до десятков запросов). Для блокировки нужны только roster,
        # устройства выбранного ребёнка и текущие overrides.
        if not self._family.accounts:
            from pyfamilysafety.account import Account
            from pyfamilysafety.device import Device

            try:
                roster = await self._family._api.async_get_accounts()
            except Exception as error:
                raise RuntimeError(f"не загружен состав семьи: {error}") from error
            members = roster.get("json", {}).get("members", [])
            matches = [
                member
                for member in members
                if member.get("isDigitalSafetyEnabled")
                and str(member.get("id")) == self._child_user_id
            ]
            if len(matches) != 1:
                raise RuntimeError(
                    f"Участник Family Safety с ID {self._child_user_id} не найден"
                )
            member = matches[0]
            account = Account(self._family._api)
            account.user_id = member.get("id")
            account.role = member.get("role")
            account.profile_picture = member.get("profilePicUrl")
            user = member.get("user") or {}
            account.first_name = user.get("firstName")
            account.surname = user.get("lastName")

            try:
                devices = await self._family._api.async_get_user_devices(
                    user_id=account.user_id
                )
            except Exception as error:
                raise RuntimeError(f"не загружены устройства: {error}") from error
            empty_usage = {"deviceUsageAggregates": {"deviceAggregates": []}}
            account.devices = Device.from_dict(devices.get("json", {}), empty_usage)
            self._family.accounts = [account]

        account = self._account()
        from pyfamilysafety.enum import OverrideTarget

        try:
            overrides = await self._family._api.async_get_override_device_restrictions(
                user_id=account.user_id
            )
        except Exception as error:
            raise RuntimeError(f"не загружена блокировка: {error}") from error
        platforms = overrides.get("json", {}).get("lockablePlatforms")
        if not isinstance(platforms, list):
            raise RuntimeError("Family Safety не вернул состояние платформ")
        blocked_platforms = []
        for platform in platforms:
            if not platform.get("overrides"):
                continue
            applies_to = platform.get("appliesTo")
            target = (
                OverrideTarget.DESKTOP
                if applies_to in {"Desktop", "Windows"}
                else OverrideTarget.from_pretty(applies_to)
            )
            if target is not None:
                blocked_platforms.append(target)
        account.blocked_platforms = blocked_platforms
        desktop_devices = [
            device for device in (account.devices or [])
            if str(device.os_name or "").lower().startswith("windows")
        ]
        if not desktop_devices:
            raise RuntimeError("У выбранного участника нет устройства Windows")

    def is_desktop_blocked(self) -> bool:
        from pyfamilysafety.enum import OverrideTarget

        return OverrideTarget.DESKTOP in (self._account().blocked_platforms or [])

    async def set_desktop_blocked(self, blocked: bool) -> None:
        from pyfamilysafety.enum import OverrideTarget, OverrideType

        account = self._account()
        if blocked:
            valid_until = datetime.now(timezone.utc) + timedelta(days=self._block_days)
            override = OverrideType.UNTIL
        else:
            valid_until = datetime.now(timezone.utc)
            override = OverrideType.CANCEL

        # В текущем API Microsoft платформа называется Windows. pyfamilysafety
        # 2.0.0 всё ещё отправляет Desktop, на что endpoint отвечает HTTP 500.
        body = {
            "target": "Windows",
            "overrideType": str(override),
            "validUntil": valid_until.strftime("%Y-%m-%dT%H:%M:%S.000%z"),
            "culture": "en-GB",
        }
        action = "применена блокировка" if blocked else "снята блокировка"
        try:
            await self._family._api.async_override_device_restriction(
                user_id=account.user_id,
                body=body,
            )
        except Exception as error:
            raise RuntimeError(f"не {action}: {error}") from error

        account.blocked_platforms = [
            target
            for target in (account.blocked_platforms or [])
            if target != OverrideTarget.DESKTOP
        ]
        if blocked:
            account.blocked_platforms.append(OverrideTarget.DESKTOP)

    async def close(self) -> None:
        await self._auth.client_session.close()
