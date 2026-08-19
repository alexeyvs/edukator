"""Конфигурация контроллера и безопасная запись его секретов."""

from __future__ import annotations

from dataclasses import dataclass, replace
import json
import os
from pathlib import Path
import tempfile
from typing import Any


DEFAULT_CONFIG = Path.home() / ".config" / "edukator" / "family-safety.json"


@dataclass(frozen=True)
class ControllerConfig:
    refresh_token: str
    child_user_id: str
    agent_token: str
    edukator_url: str
    poll_seconds: float = 20.0
    verify_seconds: float = 300.0
    block_days: int = 7

    def with_refresh_token(self, token: str) -> ControllerConfig:
        return replace(self, refresh_token=token)

    def __repr__(self) -> str:
        # Конфигурация целиком попадает в текст ошибки при любой оплошности —
        # от `assertEqual` до `repr` в трассировке. Оба секрета здесь скрыты,
        # чтобы ключ от детского аккаунта не оседал в логах и на экране.
        return (
            "ControllerConfig("
            "refresh_token=<скрыт>, "
            f"child_user_id={self.child_user_id!r}, "
            "agent_token=<скрыт>, "
            f"edukator_url={self.edukator_url!r}, "
            f"poll_seconds={self.poll_seconds!r}, "
            f"verify_seconds={self.verify_seconds!r}, "
            f"block_days={self.block_days!r})"
        )


def config_path() -> Path:
    configured = os.environ.get("EDUKATOR_FAMILY_CONFIG")
    return Path(configured).expanduser() if configured else DEFAULT_CONFIG


def pending_login_path(path: Path) -> Path:
    return path.with_name(f".{path.name}.login")


def _required_text(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Поле {key} должно быть непустой строкой")
    return value.strip()


def _read_raw(path: Path) -> dict[str, Any]:
    """Конфигурация как объект, без единой проверки полей.

    Нестрогое чтение нужно ровно там, где строгое отказывает по делу: на
    конфигурации прошлой версии, которую этот запуск и обновляет.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def read_previous_access(path: Path) -> dict[str, str]:
    """Прежние адрес сервера и агентский токен, какой бы неполной ни была конфигурация.

    Читаются отдельно от строгого `load_config` по той же причине, что и
    настройки опроса: обязательные поля прибавляются со временем, и на прежней
    конфигурации (в ней нет `agent_token`) строгое чтение отказывает целиком.
    Прежний адрес тогда не предлагался бы вовсе — а обещан он именно на
    обновлении, ради которого `family:login` и перезапускают, — и Enter в ответ
    на вопрос падал бы «адрес должен начинаться с http://», назвав виноватым
    ввод вместо настоящей причины.
    """
    raw = _read_raw(path)
    previous: dict[str, str] = {}
    for key in ("edukator_url", "agent_token"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            previous[key] = value.strip()
    return previous


def read_poll_settings(path: Path) -> dict[str, Any]:
    """Настройки опроса из конфигурации, какой бы неполной она ни была.

    Нужна отдельно от `load_config` ради повторного `family:login`: обязательные
    поля со временем прибавляются (так появились `agent_token` и
    `edukator_url`), и строгое чтение на прежней конфигурации отказывает целиком
    — то есть ровно при обновлении молча возвращает `poll_seconds`,
    `verify_seconds` и `block_days` к умолчаниям. Здесь берётся только то, что
    прочиталось: испорченное значение — не повод потерять два соседних.

    Границы те же, что у `load_config`, и по той же причине, по которой
    нечитаемое значение уходит в умолчание: сохранённый отсюда ноль пережил бы
    весь вход в Microsoft, отчитался бы «Конфигурация сохранена» — а
    `start:family` следом отказал бы «Интервалы опроса должны быть
    положительными», и виноватым выглядел бы не тот шаг.
    """
    raw = _read_raw(path)
    settings: dict[str, Any] = {}
    limits = (
        ("poll_seconds", float, lambda value: value > 0),
        ("verify_seconds", float, lambda value: value > 0),
        ("block_days", int, lambda value: value >= 1),
    )
    for key, cast, allowed in limits:
        if key not in raw:
            continue
        try:
            value = cast(raw[key])
        except (TypeError, ValueError):
            continue
        if allowed(value):
            settings[key] = value
    return settings


def _number(raw: dict[str, Any], key: str, default: Any, cast: Any) -> Any:
    """Число из конфигурации. `null` и список дают `TypeError`, а не `ValueError`,
    и без приведения он улетал бы трассировкой мимо всех `except ValueError`."""
    if key not in raw:
        return default
    try:
        return cast(raw[key])
    except (TypeError, ValueError) as error:
        raise ValueError(f"Поле {key} должно быть числом") from error


def load_config(path: Path | None = None) -> ControllerConfig:
    target = path or config_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(
            f"Конфигурация {target} не найдена; выполните edukator-family-login"
        ) from error
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Конфигурация {target} не прочитана: {error}") from error
    if not isinstance(raw, dict):
        raise ValueError("Конфигурация Family Safety должна быть JSON-объектом")

    config = ControllerConfig(
        refresh_token=_required_text(raw, "refresh_token"),
        child_user_id=_required_text(raw, "child_user_id"),
        # Адрес и агентский токен умолчания не имеют намеренно: сервер теперь
        # многоарендный, и молчаливый `localhost` без токена дал бы вечный
        # fail-closed вместо внятной жалобы на незаполненную конфигурацию.
        agent_token=_required_text(raw, "agent_token"),
        edukator_url=_required_text(raw, "edukator_url").rstrip("/"),
        poll_seconds=_number(raw, "poll_seconds", 20.0, float),
        verify_seconds=_number(raw, "verify_seconds", 300.0, float),
        block_days=_number(raw, "block_days", 7, int),
    )
    if config.poll_seconds <= 0 or config.verify_seconds <= 0:
        raise ValueError("Интервалы опроса должны быть положительными")
    if config.block_days < 1:
        raise ValueError("Срок блокировки должен быть не меньше одного дня")
    if not config.edukator_url.startswith(("http://", "https://")):
        raise ValueError("edukator_url должен начинаться с http:// или https://")
    return config


def _sync_directory(directory: Path) -> None:
    """
    Досылает на диск сам факт переименования.

    `fsync` дескриптора файла несёт содержимое, но не запись каталога: после
    сбоя питания на месте новой конфигурации оказалась бы прежняя. Microsoft
    выдаёт refresh token одноразовым и меняет его на каждом обновлении, так что
    вернувшийся старый уже не примут — вместо опроса гейта родителя ждёт
    повторный `family:login`.
    """
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        # Не всякая файловая система умеет `fsync` каталога (сеть, некоторые
        # образы). Отказ здесь не имеет права уронить сохранение: файл на месте.
        pass
    finally:
        os.close(descriptor)


def _save_private_json(payload: dict[str, Any], target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # `mode` у `mkdir` действует только на создаваемый последний каталог: уже
    # существующий `~/.config/edukator` остался бы с чем был, а в нём лежат и
    # refresh token, и агентский токен, и времянка `mkstemp` с предсказуемым
    # именем.
    try:
        os.chmod(target.parent, 0o700)
    except OSError:
        # Каталог может быть чужим (общий `~/.config` под управлением системы):
        # права файлов важнее, и они выставляются ниже независимо от этого.
        pass
    encoded = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"

    temporary: Path | None = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        temporary = Path(name)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
        os.chmod(target, 0o600)
        _sync_directory(target.parent)
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def save_config(config: ControllerConfig, path: Path | None = None) -> None:
    target = path or config_path()
    _save_private_json(
        {
            "refresh_token": config.refresh_token,
            "child_user_id": config.child_user_id,
            "agent_token": config.agent_token,
            "edukator_url": config.edukator_url,
            "poll_seconds": config.poll_seconds,
            "verify_seconds": config.verify_seconds,
            "block_days": config.block_days,
        },
        target,
    )


def save_pending_login(refresh_token: str, path: Path) -> None:
    _save_private_json({"refresh_token": refresh_token}, pending_login_path(path))


def load_pending_login(path: Path) -> str | None:
    pending = pending_login_path(path)
    try:
        raw = json.loads(pending.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Сохранённая сессия {pending} не прочитана: {error}") from error
    if not isinstance(raw, dict):
        raise ValueError(f"Сохранённая сессия {pending} должна быть JSON-объектом")
    return _required_text(raw, "refresh_token")


def clear_pending_login(path: Path) -> None:
    try:
        pending_login_path(path).unlink(missing_ok=True)
    except OSError as error:
        raise ValueError(f"Временная сессия входа не удалена: {error}") from error
