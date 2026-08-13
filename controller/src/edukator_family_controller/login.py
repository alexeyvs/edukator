"""Первичная авторизация и выбор участника Family Safety."""

from __future__ import annotations

import argparse
import asyncio
import getpass
from pathlib import Path
import sys
import webbrowser
from typing import Any, Awaitable, Callable

from .config import (
    ControllerConfig,
    clear_pending_login,
    config_path,
    load_pending_login,
    save_config,
    save_pending_login,
)


LOGIN_URL = (
    "https://login.live.com/oauth20_authorize.srf?"
    "cobrandid=b5d15d4b-695a-4cd5-93c6-13f551b310df&"
    "client_id=000000000004893A&response_type=code&"
    "redirect_uri=https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf&"
    "response_mode=query&scope=service%3A%3Afamilymobile.microsoft.com%3A%3AMBI_SSL&"
    "lw=1&fl=easi2&login_hint="
)


async def update_family_with_retry(
    family: Any,
    *,
    attempts: int = 5,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    log: Callable[[str], None] = print,
) -> None:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            await family.update()
            if not family.accounts:
                raise RuntimeError("Microsoft не вернул список участников")
            return
        except Exception as error:
            last_error = error
            if attempt == attempts:
                break
            delay = 2 ** (attempt - 1)
            log(
                f"Family Safety временно недоступен: {error}; "
                f"повтор {attempt + 1} из {attempts} через {delay} с"
            )
            await sleep(delay)
    raise RuntimeError(
        "Не удалось загрузить Family Safety после нескольких попыток. "
        "Сессия сохранена — запустите family:login ещё раз позже"
    ) from last_error


async def authenticate(target: Path) -> Any:
    from pyfamilysafety import Authenticator, FamilySafety

    pending_token = load_pending_login(target)
    if pending_token is not None:
        print("Продолжаю ранее начатую настройку Microsoft Family Safety.")
        try:
            auth = await Authenticator.create(token=pending_token, use_refresh_token=True)
            save_pending_login(auth.refresh_token, target)
            return auth
        except Exception as error:
            print(f"Сохранённая сессия больше не действует: {error}", file=sys.stderr)
            clear_pending_login(target)

    print("Открываю вход Microsoft в браузере.")
    if not webbrowser.open(LOGIN_URL):
        print(f"Если браузер не открылся, перейдите по ссылке:\n{LOGIN_URL}")
    redirect_url = getpass.getpass(
        "Вставьте полный URL пустой страницы после входа (ввод скрыт): "
    ).strip()
    if not redirect_url:
        raise ValueError("Redirect URL не введён")
    auth = await Authenticator.create(token=redirect_url)
    # OAuth-код одноразовый. С этого момента сохраняем возобновляемую сессию,
    # прежде чем обращаться к менее надёжному Family Safety aggregator.
    save_pending_login(auth.refresh_token, target)
    return auth


async def login(target: Path) -> None:
    from pyfamilysafety import FamilySafety

    auth = await authenticate(target)
    try:
        family = FamilySafety(auth)
        await update_family_with_retry(family)
        save_pending_login(auth.refresh_token, target)
        print("\nУчастники Family Safety:")
        for account in family.accounts:
            name = " ".join(filter(None, [account.first_name, account.surname])) or "без имени"
            devices = ", ".join(
                device.device_name or device.device_id for device in (account.devices or [])
            ) or "нет устройств"
            print(f"- {name}: {account.user_id} ({devices})")
        child_user_id = input("\nВставьте точный ID ребёнка: ").strip()
        matches = [
            account
            for account in family.accounts
            if str(account.user_id) == child_user_id
        ]
        if len(matches) != 1:
            raise RuntimeError("Участник с таким ID не найден")
        if not any(
            str(device.os_name or "").lower().startswith("windows")
            for device in (matches[0].devices or [])
        ):
            raise RuntimeError("У выбранного участника нет устройства Windows")
        save_config(
            ControllerConfig(
                refresh_token=auth.refresh_token,
                child_user_id=child_user_id,
            ),
            target,
        )
        clear_pending_login(target)
        print(f"Конфигурация сохранена: {target}")
    finally:
        await auth.client_session.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Вход в Microsoft Family Safety")
    parser.add_argument("--config", help="Путь к JSON-конфигурации")
    arguments = parser.parse_args()
    target = Path(arguments.config) if arguments.config else config_path()
    try:
        asyncio.run(login(target))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"Авторизация не завершена: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
