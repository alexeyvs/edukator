"""Цикл сверки дневного плана и блокировки Desktop."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
import random
import sys
import time
from pathlib import Path
from typing import Awaitable, Callable, Protocol

from .config import ControllerConfig, config_path, load_config, save_config
from .family import MicrosoftFamilyClient
from .gate import GateState, fetch_gate


class FamilyClient(Protocol):
    refresh_token: str

    async def refresh(self) -> None: ...
    def is_desktop_blocked(self) -> bool: ...
    async def set_desktop_blocked(self, blocked: bool) -> None: ...
    async def close(self) -> None: ...


@dataclass
class ReconcileState:
    actual_blocked: bool | None = None
    desired_blocked: bool | None = None
    verified_at: float = 0.0
    block_renewed_at: float | None = None
    access_expires_at: datetime | None = None
    last_gate_desired_blocked: bool | None = None


BLOCK_RENEW_SECONDS = 24 * 60 * 60
MIN_POLL_SECONDS = 1.0
# Совпадает с серверным moscow-time.ts: Москва постоянно UTC+03:00 с 2014 года.
MOSCOW_TIMEZONE = timezone(timedelta(hours=3))


def access_expiry(gate: GateState) -> datetime | None:
    if not gate.unlocked:
        return None
    if gate.override is not None and gate.override.mode == "unlocked":
        return gate.override.expires_at
    gate_day = date.fromisoformat(gate.day)
    next_day = gate_day + timedelta(days=1)
    return datetime(
        next_day.year,
        next_day.month,
        next_day.day,
        tzinfo=MOSCOW_TIMEZONE,
    ).astimezone(timezone.utc)


def cap_delay_to_access_expiry(
    delay: float,
    state: ReconcileState,
    now: datetime,
) -> float:
    expires_at = state.access_expires_at
    if expires_at is None:
        return delay
    until_expiry = (expires_at - now).total_seconds()
    return min(delay, max(MIN_POLL_SECONDS, until_expiry))


async def reconcile(
    gate: GateState,
    family: FamilyClient,
    state: ReconcileState,
    now: float,
    verify_seconds: float,
    log: Callable[[str], None],
) -> None:
    next_access_expires_at = access_expiry(gate)
    if next_access_expires_at is not None:
        # Family Safety may apply an unlock even when its response is lost. Arm
        # the local fail-closed deadline before any external call can do that.
        state.access_expires_at = next_access_expires_at
    desired = not gate.unlocked
    must_verify = (
        state.actual_blocked is None
        or state.desired_blocked != desired
        or now - state.verified_at >= verify_seconds
    )
    if must_verify:
        await family.refresh()
        state.actual_blocked = family.is_desktop_blocked()
        state.verified_at = now

    renew_block = desired and (
        state.block_renewed_at is None
        or now - state.block_renewed_at >= BLOCK_RENEW_SECONDS
    )
    if state.actual_blocked != desired or renew_block:
        was_blocked = state.actual_blocked is True
        await family.set_desktop_blocked(desired)
        state.actual_blocked = desired
        state.verified_at = now
        if desired:
            state.block_renewed_at = now
        action = "блокировка продлена" if desired and was_blocked else (
            "заблокирован" if desired else "разблокирован"
        )
        log(
            f"Desktop {action}: день {gate.day}, "
            f"завершено {gate.completed} из {gate.required}"
        )
    state.desired_blocked = desired
    if next_access_expires_at is None:
        state.access_expires_at = None


async def fail_closed_after_access_expiry(
    family: FamilyClient,
    state: ReconcileState,
    now: datetime,
    log: Callable[[str], None],
) -> None:
    """Закрывает доступ по локальному дедлайну, пока сервер не подтвердит новый день."""
    expires_at = state.access_expires_at
    if expires_at is None or now < expires_at:
        return
    await ensure_fail_closed(
        family,
        state,
        log,
        "срок разрешённого доступа истёк",
    )
    # После дедлайна локальный blocked intent действует до следующего валидного
    # gate. Это позволяет восстанавливать конечный Family Safety UNTIL при outage.
    state.last_gate_desired_blocked = True
    state.access_expires_at = None


async def ensure_fail_closed(
    family: FamilyClient,
    state: ReconcileState,
    log: Callable[[str], None],
    reason: str,
) -> None:
    """Проверяет безопасную блокировку, когда желаемое состояние неизвестно."""
    await family.refresh()
    actual_blocked = family.is_desktop_blocked()
    if not actual_blocked:
        await family.set_desktop_blocked(True)
        log(f"Desktop заблокирован: {reason}")
    state.actual_blocked = True
    state.desired_blocked = True


async def run_controller(
    config: ControllerConfig,
    family: FamilyClient,
    *,
    gate_reader: Callable[[str], Awaitable[GateState]] = fetch_gate,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], float] = time.monotonic,
    wall_clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    log: Callable[[str], None] = print,
    config_saver: Callable[[ControllerConfig], None] = save_config,
) -> None:
    state = ReconcileState()
    failures = 0
    saved_token = config.refresh_token
    try:
        while True:
            try:
                gate = await gate_reader(config.edukator_url)
                state.last_gate_desired_blocked = not gate.unlocked
                await reconcile(
                    gate,
                    family,
                    state,
                    clock(),
                    config.verify_seconds,
                    log,
                )
                await fail_closed_after_access_expiry(
                    family, state, wall_clock(), log
                )
                if family.refresh_token != saved_token:
                    config = config.with_refresh_token(family.refresh_token)
                    config_saver(config)
                    saved_token = family.refresh_token
                failures = 0
                delay = cap_delay_to_access_expiry(
                    config.poll_seconds,
                    state,
                    wall_clock(),
                )
                await sleep(delay)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # сеть и закрытый API должны восстанавливаться
                try:
                    if state.last_gate_desired_blocked is None:
                        await ensure_fail_closed(
                            family,
                            state,
                            log,
                            "Edukator ещё не подтвердил состояние после запуска",
                        )
                    elif state.last_gate_desired_blocked:
                        await ensure_fail_closed(
                            family,
                            state,
                            log,
                            "Edukator подтвердил требование блокировки",
                        )
                        state.access_expires_at = None
                    else:
                        await fail_closed_after_access_expiry(
                            family, state, wall_clock(), log
                        )
                except asyncio.CancelledError:
                    raise
                except Exception as safety_error:
                    error = RuntimeError(
                        f"{error}; аварийная блокировка не выполнена: {safety_error}"
                    )
                failures += 1
                delay = min(300.0, config.poll_seconds * (2 ** min(failures - 1, 4)))
                delay *= random.uniform(0.9, 1.1)
                delay = cap_delay_to_access_expiry(
                    delay,
                    state,
                    wall_clock(),
                )
                log(f"Сверка не выполнена: {error}; повтор через {delay:.0f} с")
                await sleep(delay)
    finally:
        await family.close()


async def async_main(config_file: str | None = None) -> None:
    path = None if config_file is None else Path(config_file)
    config = load_config(path)
    family = await MicrosoftFamilyClient.create(config)
    if family.refresh_token != config.refresh_token:
        config = config.with_refresh_token(family.refresh_token)
        save_config(config, path)
    print(f"Family Safety controller запущен; конфигурация: {path or config_path()}")
    await run_controller(
        config,
        family,
        config_saver=lambda updated: save_config(updated, path),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Контроллер блокировки Edukator")
    parser.add_argument("--config", help="Путь к JSON-конфигурации")
    arguments = parser.parse_args()
    try:
        asyncio.run(async_main(arguments.config))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"Family Safety controller не запущен: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
