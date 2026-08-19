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
        poll_seconds=float(raw.get("poll_seconds", 20)),
        verify_seconds=float(raw.get("verify_seconds", 300)),
        block_days=int(raw.get("block_days", 7)),
    )
    if config.poll_seconds <= 0 or config.verify_seconds <= 0:
        raise ValueError("Интервалы опроса должны быть положительными")
    if config.block_days < 1:
        raise ValueError("Срок блокировки должен быть не меньше одного дня")
    if not config.edukator_url.startswith(("http://", "https://")):
        raise ValueError("edukator_url должен начинаться с http:// или https://")
    return config


def _save_private_json(payload: dict[str, Any], target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
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
