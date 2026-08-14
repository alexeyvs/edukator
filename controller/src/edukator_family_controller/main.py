"""Цикл сверки дневного плана и блокировки Desktop."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
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
    unlocked_override_expires_at: datetime | None = None
    gate_reconciled: bool = False


BLOCK_RENEW_SECONDS = 24 * 60 * 60


async def reconcile(
    gate: GateState,
    family: FamilyClient,
    state: ReconcileState,
    now: float,
    verify_seconds: float,
    log: Callable[[str], None],
) -> None:
    forced_unlock_expires_at = (
        gate.override.expires_at
        if gate.override is not None and gate.override.mode == "unlocked"
        else None
    )
    if forced_unlock_expires_at is not None:
        # Family Safety may apply an unlock even when its response is lost. Arm
        # the local fail-closed deadline before any external call can do that.
        state.unlocked_override_expires_at = forced_unlock_expires_at
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
    if forced_unlock_expires_at is None:
        state.unlocked_override_expires_at = None


async def fail_closed_after_override_expiry(
    family: FamilyClient,
    state: ReconcileState,
    now: datetime,
    log: Callable[[str], None],
) -> None:
    """Закрывает доступ по локальному дедлайну, пока сервер не подтвердит автоматику."""
    expires_at = state.unlocked_override_expires_at
    if expires_at is None or now < expires_at:
        return
    await ensure_fail_closed(
        family,
        state,
        log,
        "срок временной разблокировки истёк",
    )
    state.unlocked_override_expires_at = None


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
                await reconcile(
                    gate,
                    family,
                    state,
                    clock(),
                    config.verify_seconds,
                    log,
                )
                state.gate_reconciled = True
                if family.refresh_token != saved_token:
                    config = config.with_refresh_token(family.refresh_token)
                    config_saver(config)
                    saved_token = family.refresh_token
                failures = 0
                await sleep(config.poll_seconds)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # сеть и закрытый API должны восстанавливаться
                try:
                    if state.gate_reconciled:
                        await fail_closed_after_override_expiry(
                            family, state, wall_clock(), log
                        )
                    else:
                        await ensure_fail_closed(
                            family,
                            state,
                            log,
                            "Edukator ещё не подтвердил состояние после запуска",
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
                if state.unlocked_override_expires_at is not None:
                    until_expiry = (
                        state.unlocked_override_expires_at - wall_clock()
                    ).total_seconds()
                    delay = min(delay, max(1.0, until_expiry))
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
