"""Цикл сверки дневного плана и блокировки Desktop."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
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


BLOCK_RENEW_SECONDS = 24 * 60 * 60


async def reconcile(
    gate: GateState,
    family: FamilyClient,
    state: ReconcileState,
    now: float,
    verify_seconds: float,
    log: Callable[[str], None],
) -> None:
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


async def run_controller(
    config: ControllerConfig,
    family: FamilyClient,
    *,
    gate_reader: Callable[[str], Awaitable[GateState]] = fetch_gate,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], float] = time.monotonic,
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
                if family.refresh_token != saved_token:
                    config = config.with_refresh_token(family.refresh_token)
                    config_saver(config)
                    saved_token = family.refresh_token
                failures = 0
                await sleep(config.poll_seconds)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # сеть и закрытый API должны восстанавливаться
                failures += 1
                delay = min(300.0, config.poll_seconds * (2 ** min(failures - 1, 4)))
                delay *= random.uniform(0.9, 1.1)
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
