"""HTTP-контракт состояния дневного плана Edukator."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


@dataclass(frozen=True)
class LearningGateState:
    material_id: int | None
    required: bool
    passed: bool


@dataclass(frozen=True)
class ComputerAccessOverride:
    mode: str
    changed_at: datetime
    expires_at: datetime


@dataclass(frozen=True)
class GateState:
    day: str
    required: int
    completed: int
    remaining: int
    learning: LearningGateState
    automatic_unlocked: bool
    override: ComputerAccessOverride | None
    unlocked: bool


def _parse_override(raw: Any) -> ComputerAccessOverride | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("Поле override должно быть JSON-объектом или null")
    for key in ("mode", "changedAt", "expiresAt"):
        if key not in raw:
            raise ValueError(f"В поле override нет поля {key}")
    if raw["mode"] not in ("blocked", "unlocked"):
        raise ValueError("Поле override.mode должно быть blocked или unlocked")
    timestamps: list[datetime] = []
    for key in ("changedAt", "expiresAt"):
        value = raw[key]
        if not isinstance(value, str) or not value:
            raise ValueError(f"Поле override.{key} должно быть ISO-отметкой времени")
        try:
            timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(
                f"Поле override.{key} должно быть ISO-отметкой времени"
            ) from error
        if timestamp.tzinfo is None:
            raise ValueError(f"Поле override.{key} должно содержать часовой пояс")
        timestamps.append(timestamp)
    if timestamps[1] <= timestamps[0]:
        raise ValueError("Поле override.expiresAt должно быть позже changedAt")
    return ComputerAccessOverride(
        mode=raw["mode"],
        changed_at=timestamps[0],
        expires_at=timestamps[1],
    )


def parse_gate(raw: Any) -> GateState:
    if not isinstance(raw, dict):
        raise ValueError("Ответ gate/status должен быть JSON-объектом")
    for key in ("day", "required", "completed", "remaining", "learning", "unlocked"):
        if key not in raw:
            raise ValueError(f"В ответе gate/status нет поля {key}")
    if not isinstance(raw["day"], str) or not raw["day"]:
        raise ValueError("Поле day должно быть непустой строкой")
    integer_values = (raw["required"], raw["completed"], raw["remaining"])
    if any(isinstance(value, bool) or not isinstance(value, int) for value in integer_values):
        raise ValueError("required, completed и remaining должны быть целыми числами")
    if not isinstance(raw["unlocked"], bool):
        raise ValueError("Поле unlocked должно быть логическим")
    learning = raw["learning"]
    if not isinstance(learning, dict):
        raise ValueError("Поле learning должно быть JSON-объектом")
    for key in ("materialId", "required", "passed"):
        if key not in learning:
            raise ValueError(f"В поле learning нет поля {key}")
    material_id = learning["materialId"]
    if material_id is not None and (
        isinstance(material_id, bool) or not isinstance(material_id, int) or material_id <= 0
    ):
        raise ValueError("Поле learning.materialId должно быть положительным целым или null")
    if not isinstance(learning["required"], bool) or not isinstance(learning["passed"], bool):
        raise ValueError("Поля learning.required и learning.passed должны быть логическими")
    if (learning["required"] or learning["passed"]) and material_id is None:
        raise ValueError("Обязательный или зачтённый разбор должен ссылаться на материал")
    if learning["passed"] and not learning["required"]:
        raise ValueError("Зачтённый разбор должен быть обязательным")
    if raw["required"] <= 0 or raw["completed"] < 0 or raw["remaining"] < 0:
        raise ValueError("Счётчики gate/status вышли за допустимые границы")
    expected_remaining = max(0, raw["required"] - raw["completed"])
    expected_unlocked = (
        raw["completed"] >= raw["required"]
        and (not learning["required"] or learning["passed"])
    )
    has_automatic = "automaticUnlocked" in raw
    has_override = "override" in raw
    if has_automatic != has_override:
        missing = "override" if has_automatic else "automaticUnlocked"
        raise ValueError(f"В ответе gate/status нет поля {missing}")
    if has_automatic:
        if not isinstance(raw["automaticUnlocked"], bool):
            raise ValueError("Поле automaticUnlocked должно быть логическим")
        automatic_unlocked = raw["automaticUnlocked"]
        override = _parse_override(raw["override"])
    else:
        # Сервер до появления ручного управления передавал только автоматический итог.
        automatic_unlocked = raw["unlocked"]
        override = None
    effective_unlocked = (
        automatic_unlocked if override is None else override.mode == "unlocked"
    )
    if (
        raw["remaining"] != expected_remaining
        or automatic_unlocked != expected_unlocked
        or raw["unlocked"] != effective_unlocked
    ):
        raise ValueError("Поля gate/status противоречат друг другу")
    return GateState(
        day=raw["day"],
        required=raw["required"],
        completed=raw["completed"],
        remaining=raw["remaining"],
        learning=LearningGateState(
            material_id=material_id,
            required=learning["required"],
            passed=learning["passed"],
        ),
        automatic_unlocked=automatic_unlocked,
        override=override,
        unlocked=raw["unlocked"],
    )


def _fetch_gate(url: str, timeout: float) -> GateState:
    try:
        with urlopen(f"{url}/api/gate/status", timeout=timeout) as response:
            return parse_gate(json.load(response))
    except HTTPError as error:
        raise RuntimeError(f"Edukator ответил HTTP {error.code}") from error
    except URLError as error:
        raise RuntimeError(f"Edukator недоступен: {error.reason}") from error
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(f"Ответ Edukator не принят: {error}") from error


async def fetch_gate(url: str, timeout: float = 5.0) -> GateState:
    return await asyncio.to_thread(_fetch_gate, url, timeout)
