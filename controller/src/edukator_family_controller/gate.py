"""HTTP-контракт состояния дневного плана Edukator."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


@dataclass(frozen=True)
class GateState:
    day: str
    required: int
    completed: int
    remaining: int
    unlocked: bool


def parse_gate(raw: Any) -> GateState:
    if not isinstance(raw, dict):
        raise ValueError("Ответ gate/status должен быть JSON-объектом")
    for key in ("day", "required", "completed", "remaining", "unlocked"):
        if key not in raw:
            raise ValueError(f"В ответе gate/status нет поля {key}")
    if not isinstance(raw["day"], str) or not raw["day"]:
        raise ValueError("Поле day должно быть непустой строкой")
    integer_values = (raw["required"], raw["completed"], raw["remaining"])
    if any(isinstance(value, bool) or not isinstance(value, int) for value in integer_values):
        raise ValueError("required, completed и remaining должны быть целыми числами")
    if not isinstance(raw["unlocked"], bool):
        raise ValueError("Поле unlocked должно быть логическим")
    if raw["required"] <= 0 or raw["completed"] < 0 or raw["remaining"] < 0:
        raise ValueError("Счётчики gate/status вышли за допустимые границы")
    expected_remaining = max(0, raw["required"] - raw["completed"])
    expected_unlocked = raw["completed"] >= raw["required"]
    if raw["remaining"] != expected_remaining or raw["unlocked"] != expected_unlocked:
        raise ValueError("Поля gate/status противоречат друг другу")
    return GateState(
        day=raw["day"],
        required=raw["required"],
        completed=raw["completed"],
        remaining=raw["remaining"],
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
