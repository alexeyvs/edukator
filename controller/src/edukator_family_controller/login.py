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
    read_poll_settings,
    read_previous_access,
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


def ask_server_access(
    target: Path,
    *,
    ask: Callable[[str], str] = input,
    ask_secret: Callable[[str], str] = getpass.getpass,
) -> tuple[str, str]:
    """Спрашивает адрес сервера и агентский токен устройства.

    Токен читается скрытым вводом: он равнозначен ключу от детского аккаунта,
    и эхо в терминале осталось бы и в истории сессии, и в записи экрана.
    """
    # Прежние значения читаются нестрого: строгий `load_config` отказывает на
    # конфигурации без `agent_token` — то есть ровно на той, ради обновления
    # которой этот `family:login` и запускают, — и прежний адрес, обещанный
    # README именно для этого случая, не предлагался бы вовсе.
    previous = read_previous_access(target)
    default_url = previous.get("edukator_url", "")
    previous_token = previous.get("agent_token", "")

    hint = f" [{default_url}]" if default_url else " (например https://edukator.example.com)"
    url = (ask(f"Адрес сервера Edukator{hint}: ").strip() or default_url).rstrip("/")
    if not url.startswith(("http://", "https://")):
        raise ValueError("Адрес сервера должен начинаться с http:// или https://")

    keep = " (Enter — оставить прежний)" if previous_token else ""
    token = ask_secret(f"Агентский токен устройства{keep}, ввод скрыт: ").strip() or previous_token
    if not token:
        raise ValueError(
            "Агентский токен не введён; выпустите устройству kind=agent в разделе «Семья»"
        )
    return url, token


# Отказы, означающие «до Microsoft не доехали», а не «токен больше не годен».
# Имена, а не классы: `aiohttp` здесь не импортируется, а тянуть его ради одного
# `isinstance` значило бы завести у входа вторую зависимость от внутренностей
# `pyfamilysafety`.
_TRANSIENT_ERROR_NAMES = frozenset({
    "ClientConnectionError",
    "ClientConnectorError",
    "ClientOSError",
    "ClientPayloadError",
    "ServerDisconnectedError",
    "ServerTimeoutError",
})


def _is_transient(error: BaseException) -> bool:
    """Обрыв связи, а не отвергнутый токен.

    Разделение нужно потому, что refresh token одноразовый: сохранённый —
    единственный способ продолжить настройку, и стереть его на отвалившемся
    Wi-Fi значит отправить родителя проходить весь вход Microsoft заново, пока
    компьютер ребёнка стоит заблокированным (контроллер fail-closed).
    """
    if isinstance(error, (OSError, TimeoutError)):
        return True
    status = getattr(error, "status", None)
    if isinstance(status, int) and status >= 500:
        return True
    return any(klass.__name__ in _TRANSIENT_ERROR_NAMES for klass in type(error).__mro__)


async def authenticate(target: Path) -> Any:
    from pyfamilysafety import Authenticator

    pending_token = load_pending_login(target)
    if pending_token is not None:
        print("Продолжаю ранее начатую настройку Microsoft Family Safety.")
        auth = None
        try:
            auth = await Authenticator.create(token=pending_token, use_refresh_token=True)
        except Exception as error:
            if _is_transient(error):
                # Сессию не отвергли — до неё не доехали. Файл остаётся: вход
                # ниже её перезапишет, а прерванный на полпути — не потеряет.
                print(f"Сессия не проверена: {error}", file=sys.stderr)
            else:
                print(f"Сохранённая сессия больше не действует: {error}", file=sys.stderr)
                # Уборка в своём `try`: `clear_pending_login` бросает `ValueError`
                # на `OSError`, и отсюда он заслонил бы настоящую причину и увёл
                # бы вход мимо браузерного сценария, к которому и надо перейти.
                try:
                    clear_pending_login(target)
                except ValueError as cleanup:
                    print(f"Временная сессия не удалена: {cleanup}", file=sys.stderr)
        if auth is not None:
            # Запись обновлённого токена — уже не проверка сессии, и её отказ
            # не повод объявлять сессию мёртвой: стерев pending, мы потеряли бы
            # действующий refresh token из-за нехватки места на диске.
            try:
                save_pending_login(auth.refresh_token, target)
            except OSError as error:
                print(f"Сессия не сохранена: {error}", file=sys.stderr)
            return auth

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


def merged_config(
    target: Path,
    *,
    refresh_token: str,
    child_user_id: str,
    agent_token: str,
    edukator_url: str,
) -> ControllerConfig:
    """Новая конфигурация поверх прежней.

    Настройки опроса переживают ротацию токена: собранная с нуля конфигурация
    молча возвращала бы `poll_seconds`, `verify_seconds` и `block_days` к
    умолчаниям при каждом повторном `family:login`.
    """
    # Настройки опроса читаются отдельно от строгого `load_config`: на прежней
    # конфигурации, у которой ещё нет `agent_token` и `edukator_url`, он
    # отказывает целиком — то есть ровно при обновлении, ради которого этот
    # `family:login` и запускают, все три настройки молча вернулись бы к
    # умолчаниям. Нет файла или он испорчен — читается пустота, и умолчания
    # берутся честно.
    return ControllerConfig(
        refresh_token=refresh_token,
        child_user_id=child_user_id,
        agent_token=agent_token,
        edukator_url=edukator_url,
        **read_poll_settings(target),
    )


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
        edukator_url, agent_token = ask_server_access(target)
        save_config(
            merged_config(
                target,
                refresh_token=auth.refresh_token,
                child_user_id=child_user_id,
                agent_token=agent_token,
                edukator_url=edukator_url,
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
