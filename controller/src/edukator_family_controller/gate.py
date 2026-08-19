"""HTTP-контракт состояния дневного плана Edukator."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date, datetime
from http.client import HTTPConnection, HTTPSConnection
import json
import socket
import threading
from time import monotonic
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import (
    HTTPHandler,
    HTTPRedirectHandler,
    HTTPSHandler,
    OpenerDirector,
    ProxyHandler,
    Request,
    build_opener,
)


class GateTokenRejected(RuntimeError):
    """Edukator rejected the controller's agent credential."""


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
    if not isinstance(raw["day"], str):
        raise ValueError("Поле day должно быть датой в формате YYYY-MM-DD")
    try:
        parsed_day = date.fromisoformat(raw["day"])
    except ValueError as error:
        raise ValueError("Поле day должно быть датой в формате YYYY-MM-DD") from error
    if parsed_day.isoformat() != raw["day"]:
        raise ValueError("Поле day должно быть датой в формате YYYY-MM-DD")
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


# Общий срок текущего запроса. Поточная переменная, а не аргумент, потому что
# соединение заводит urllib внутри `open`: подсунуть ему число можно только так.
# Каждый `_fetch_gate` идёт своим `asyncio.to_thread`, так что чужого срока в
# ней не окажется.
_DEADLINE = threading.local()


class _DeadlineConnection:
    """Соединение, закрывающееся по общему сроку запроса.

    Сокетный `timeout` отмеряет **отдельную** операцию, а не запрос целиком, и
    статус со строками заголовков читается до всякого тела: собеседник,
    отдающий бесконечную череду `100 Continue` (или заголовки по строке) чуть
    чаще, чем раз в `timeout`, держит `getresponse()` сколько угодно долго.
    Снаружи такой поток не отменить — брошенный `asyncio.wait_for` освобождает
    только ждущего, — и пара таких за сутки опроса съедает пул `to_thread`
    целиком: каждый следующий `fetch_gate` отваливается по сроку, ни разу не
    сходив на сервер, то есть контроллер перестаёт замечать и выздоровевший
    сервер. Срок здесь тот же, что у `_read_body` и у `fetch_gate`: разъехавшись,
    они дали бы либо поток, переживающий свой запрос, либо отказ раньше срока.
    """

    def _abort(self) -> None:
        """Обрывает чтение из чужого потока.

        Одного `close()` мало: `makefile` держит свою ссылку на сокет, и закрытие
        соединения при живом читателе фактический дескриптор не трогает —
        `getresponse()` продолжал бы читать заголовки как ни в чём не бывало.
        `shutdown` же обрывает сам обмен, и читающий получает конец потока.
        """
        opened = self.sock  # type: ignore[attr-defined]
        if opened is not None:
            try:
                opened.shutdown(socket.SHUT_RDWR)
            except OSError:
                # Собеседник уже отвалился сам: обрывать нечего.
                pass

    def getresponse(self) -> Any:
        deadline = getattr(_DEADLINE, "value", None)
        if deadline is None:
            return super().getresponse()  # type: ignore[misc]
        watchdog = threading.Timer(max(0.0, deadline - monotonic()), self._abort)
        watchdog.daemon = True
        watchdog.start()
        try:
            return super().getresponse()  # type: ignore[misc]
        finally:
            watchdog.cancel()


class _DeadlineHTTPConnection(_DeadlineConnection, HTTPConnection):
    pass


class _DeadlineHTTPSConnection(_DeadlineConnection, HTTPSConnection):
    pass


class _DeadlineHTTPHandler(HTTPHandler):
    def http_open(self, req: Any) -> Any:
        return self.do_open(_DeadlineHTTPConnection, req)


class _DeadlineHTTPSHandler(HTTPSHandler):
    def https_open(self, req: Any) -> Any:
        return self.do_open(_DeadlineHTTPSConnection, req, context=self._context)


class _RefuseRedirect(HTTPRedirectHandler):
    """Запрещает переходы: urllib унёс бы агентский токен на чужой адрес."""

    def redirect_request(self, *_arguments: Any, **_keywords: Any) -> None:
        return None


def _build_opener() -> OpenerDirector:
    """Открыватель, который несёт агентский токен ровно на указанный адрес.

    `ProxyHandler({})` выписан руками: без него `build_opener` ставит
    умолчательный, а тот читает `http_proxy`/`https_proxy` и системные настройки
    macOS. Адрес Edukator — домашний, по документации простой http, и `no_proxy`
    его не исключает, так что настроенный прокси получал бы
    `Authorization: Bearer <агентский токен>` открытым текстом. Запрет переходов
    рядом закрывает ровно ту же дыру с другой стороны.
    """
    return build_opener(
        ProxyHandler({}),
        _RefuseRedirect,
        _DeadlineHTTPHandler,
        _DeadlineHTTPSHandler,
    )


_OPENER = _build_opener()


# Ответ `gate/status` — десяток полей. Предел стоит не от сервера, а от того,
# что на его адресе может оказаться что угодно: `json.load` читает поток до
# конца, и бесконечная выдача чужой службы съела бы память контроллера.
MAX_GATE_BODY = 64 * 1024


# Во сколько раз общий срок больше сокетного. `timeout` у `urlopen` действует на
# **отдельную** операцию с сокетом, а не на запрос целиком: собеседник, отдающий
# по байту раз в четыре секунды, продлевает чтение бесконечно.
GATE_DEADLINE_FACTOR = 3


def _read_body(response: Any, deadline: float) -> bytes:
    """Тело ответа с общим сроком на чтение.

    `response.read(n)` возвращается только с полными `n` байтами или концом
    потока, а сокетный `timeout` отмеряется каждой отдельной порции: собеседник,
    отдающий по байту раз в четыре секунды, держит один такой вызов сколько
    угодно долго. Срок поэтому проверяется между порциями, а не вокруг всего
    чтения: снаружи его отменить нечем — поток `asyncio.to_thread` не
    прерывается, и брошенный `wait_for`-ом он остаётся висеть на сокете. Пара
    таких за сутки опроса — и рабочих потоков не остаётся вовсе: каждый
    следующий `fetch_gate` отваливается по сроку, ни разу не сходив на сервер,
    то есть контроллер перестаёт замечать и выздоровевший сервер.
    """
    chunks: list[bytes] = []
    size = 0
    while size <= MAX_GATE_BODY:
        if monotonic() >= deadline:
            raise RuntimeError("Edukator не дочитан за отведённый срок")
        chunk = response.read1(MAX_GATE_BODY + 1 - size)
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    return b"".join(chunks)


def _fetch_gate(url: str, token: str, timeout: float) -> GateState:
    request = Request(
        f"{url}/api/gate/status",
        # Ровно тот заголовок, который разбирает `readAgentToken` на сервере.
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    deadline = monotonic() + timeout * GATE_DEADLINE_FACTOR
    _DEADLINE.value = deadline
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            payload = _read_body(response, deadline)
            if len(payload) > MAX_GATE_BODY:
                raise RuntimeError(f"Ответ Edukator длиннее {MAX_GATE_BODY} байт")
            return parse_gate(json.loads(payload))
    except HTTPError as error:
        # `HTTPError` — это ещё и открытый ответ: `_OPENER.open` бросает его до
        # входа в `with`, так что сокет никто не закроет, а сама ошибка живёт
        # причиной у `RuntimeError` весь отступ (до пяти минут). Отозванный токен
        # даёт 401 на каждом опросе — то есть по дескриптору на опрос.
        error.close()
        if error.code in (401, 403):
            # Отозванное или подменённое устройство: причина названа прямо,
            # но сам токен в текст не попадает — его читают в логах.
            raise GateTokenRejected(
                f"Edukator не принял агентский токен (HTTP {error.code}); "
                "выпустите устройству новую ссылку"
            ) from error
        raise RuntimeError(f"Edukator ответил HTTP {error.code}") from error
    except URLError as error:
        raise RuntimeError(f"Edukator недоступен: {error.reason}") from error
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(f"Ответ Edukator не принят: {error}") from error
    finally:
        _DEADLINE.value = None


async def fetch_gate(url: str, token: str, timeout: float = 5.0) -> GateState:
    """Состояние доступа с общим сроком на весь запрос.

    Без него зависшее чтение оставляло бы `run_controller` ждать навечно: ни
    ветка аварийной блокировки, ни `fail_closed_after_access_expiry` не
    выполнились бы ни разу, и выданный доступ дожил бы до своего конца —
    контроллер завис бы **открытым**, то есть потерял бы единственное свойство,
    ради которого он и написан.

    Ждущего он, однако, только освобождает: поток `asyncio.to_thread` брошенный
    `wait_for` не прерывает. Заканчивает поток тот же срок, отмеренный **внутри**
    (`_read_body`), и держится он на одном числе с этим: разъехавшись, они дали
    бы либо поток, переживающий свой запрос, либо отказ раньше срока.
    """
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_fetch_gate, url, token, timeout),
            timeout=timeout * GATE_DEADLINE_FACTOR,
        )
    except asyncio.TimeoutError as error:
        raise RuntimeError(
            f"Edukator не ответил за {timeout * GATE_DEADLINE_FACTOR:.0f} с"
        ) from error
