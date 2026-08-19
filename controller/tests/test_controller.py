from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import stat
import threading
import time
from typing import Any, Iterator
import unittest
from unittest import mock
from urllib.error import HTTPError

from edukator_family_controller import gate as gate_module
from edukator_family_controller.config import (
    ControllerConfig,
    clear_pending_login,
    load_config,
    load_pending_login,
    pending_login_path,
    read_poll_settings,
    read_previous_access,
    save_config,
    save_pending_login,
)
from edukator_family_controller.gate import (
    MAX_GATE_BODY,
    ComputerAccessOverride,
    GateState,
    GateTokenRejected,
    LearningGateState,
    fetch_gate,
    parse_gate,
)
from edukator_family_controller.family import MicrosoftFamilyClient
from edukator_family_controller.login import (
    ask_server_access,
    merged_config,
    update_family_with_retry,
)
from edukator_family_controller.main import (
    BLOCK_RENEW_SECONDS,
    ReconcileState,
    cap_delay_to_safety_wake,
    ensure_fail_closed,
    reconcile,
    run_controller,
)


AGENT_TOKEN = "agent-secret-token"
EDUKATOR_URL = "http://127.0.0.1:3000"

LOCKED = GateState(
    day="2026-08-12",
    required=3,
    completed=1,
    remaining=2,
    learning=LearningGateState(material_id=None, required=False, passed=False),
    automatic_unlocked=False,
    override=None,
    unlocked=False,
)
UNLOCKED = GateState(
    day="2026-08-12",
    required=3,
    completed=3,
    remaining=0,
    learning=LearningGateState(material_id=7, required=True, passed=True),
    automatic_unlocked=True,
    override=None,
    unlocked=True,
)


def forced_unlocked_gate(
    *,
    day: str = "2026-08-12",
    changed_at: str = "2026-08-12T20:59:00.000Z",
    expires_at: str = "2026-08-12T21:00:00.000Z",
) -> GateState:
    return parse_gate(
        {
            "day": day,
            "required": 3,
            "completed": 0,
            "remaining": 3,
            "learning": {
                "materialId": None,
                "required": False,
                "passed": False,
            },
            "automaticUnlocked": False,
            "override": {
                "mode": "unlocked",
                "changedAt": changed_at,
                "expiresAt": expires_at,
            },
            "unlocked": True,
        }
    )


def legacy_unlocked_gate() -> GateState:
    return parse_gate(
        {
            "day": "2026-08-12",
            "required": 3,
            "completed": 3,
            "remaining": 0,
            "learning": {
                "materialId": None,
                "required": False,
                "passed": False,
            },
            "unlocked": True,
        }
    )


class FakeFamily:
    def __init__(self, blocked: bool) -> None:
        self.blocked = blocked
        self.refresh_token = "refresh"
        self.refreshes = 0
        self.actions: list[bool] = []
        self.closed = False

    async def refresh(self) -> None:
        self.refreshes += 1

    def is_desktop_blocked(self) -> bool:
        return self.blocked

    async def set_desktop_blocked(self, blocked: bool) -> None:
        self.blocked = blocked
        self.actions.append(blocked)

    async def close(self) -> None:
        self.closed = True


class FailFirstBlockFamily(FakeFamily):
    def __init__(self, blocked: bool, *, failures: int = 1) -> None:
        super().__init__(blocked)
        self.block_failures = failures
        self.block_attempts = 0

    async def set_desktop_blocked(self, blocked: bool) -> None:
        if blocked:
            self.block_attempts += 1
            if self.block_attempts <= self.block_failures:
                raise RuntimeError("Family Safety apply failed")
        await super().set_desktop_blocked(blocked)


class FailFirstUnlockFamily(FakeFamily):
    def __init__(self, blocked: bool, *, apply_before_failure: bool = False) -> None:
        super().__init__(blocked)
        self.apply_before_failure = apply_before_failure
        self.unlock_attempts = 0

    async def set_desktop_blocked(self, blocked: bool) -> None:
        if not blocked:
            self.unlock_attempts += 1
            if self.unlock_attempts == 1:
                if self.apply_before_failure:
                    await super().set_desktop_blocked(False)
                raise RuntimeError("Family Safety unlock response lost")
        await super().set_desktop_blocked(blocked)


class FailFirstRefreshFamily(FakeFamily):
    async def refresh(self) -> None:
        await super().refresh()
        if self.refreshes == 1:
            raise RuntimeError("Family Safety refresh failed")


class GateContractTests(unittest.TestCase):
    def test_accepts_legacy_state_without_override_fields(self) -> None:
        self.assertEqual(
            parse_gate(
                {
                    "day": "2026-08-12",
                    "required": 3,
                    "completed": 2,
                    "remaining": 1,
                    "learning": {
                        "materialId": 7,
                        "required": True,
                        "passed": True,
                    },
                    "unlocked": False,
                }
            ),
            GateState(
                day="2026-08-12",
                required=3,
                completed=2,
                remaining=1,
                learning=LearningGateState(7, True, True),
                automatic_unlocked=False,
                override=None,
                unlocked=False,
            ),
        )

    def test_accepts_legacy_unlocked_state(self) -> None:
        state = parse_gate(
            {
                "day": "2026-08-12",
                "required": 3,
                "completed": 3,
                "remaining": 0,
                "learning": {
                    "materialId": None,
                    "required": False,
                    "passed": False,
                },
                "unlocked": True,
            }
        )

        self.assertTrue(state.automatic_unlocked)
        self.assertTrue(state.unlocked)

    def test_accepts_new_automatic_state_without_override(self) -> None:
        state = parse_gate(
            {
                "day": "2026-08-12",
                "required": 3,
                "completed": 3,
                "remaining": 0,
                "learning": {
                    "materialId": None,
                    "required": False,
                    "passed": False,
                },
                "automaticUnlocked": True,
                "override": None,
                "unlocked": True,
            }
        )
        self.assertTrue(state.automatic_unlocked)
        self.assertIsNone(state.override)
        self.assertTrue(state.unlocked)

    def test_accepts_forced_unlocked_state_before_plan_completion(self) -> None:
        state = parse_gate(
            {
                "day": "2026-08-12",
                "required": 3,
                "completed": 1,
                "remaining": 2,
                "learning": {
                    "materialId": None,
                    "required": False,
                    "passed": False,
                },
                "automaticUnlocked": False,
                "override": {
                    "mode": "unlocked",
                    "changedAt": "2026-08-12T10:00:00.000Z",
                    "expiresAt": "2026-08-12T21:00:00.000Z",
                },
                "unlocked": True,
            }
        )

        self.assertEqual(
            state.override,
            ComputerAccessOverride(
                mode="unlocked",
                changed_at=datetime(2026, 8, 12, 10, tzinfo=timezone.utc),
                expires_at=datetime(2026, 8, 12, 21, tzinfo=timezone.utc),
            ),
        )
        self.assertFalse(state.automatic_unlocked)
        self.assertTrue(state.unlocked)

    def test_accepts_forced_blocked_state_after_plan_completion(self) -> None:
        state = parse_gate(
            {
                "day": "2026-08-12",
                "required": 3,
                "completed": 3,
                "remaining": 0,
                "learning": {
                    "materialId": 7,
                    "required": True,
                    "passed": True,
                },
                "automaticUnlocked": True,
                "override": {
                    "mode": "blocked",
                    "changedAt": "2026-08-12T10:00:00.000Z",
                    "expiresAt": "2026-08-12T21:00:00.000Z",
                },
                "unlocked": False,
            }
        )

        self.assertEqual(state.override.mode, "blocked")
        self.assertTrue(state.automatic_unlocked)
        self.assertFalse(state.unlocked)

    def test_rejects_effective_state_that_disagrees_with_override(self) -> None:
        with self.assertRaisesRegex(ValueError, "противоречат"):
            parse_gate(
                {
                    "day": "2026-08-12",
                    "required": 3,
                    "completed": 1,
                    "remaining": 2,
                    "learning": {
                        "materialId": None,
                        "required": False,
                        "passed": False,
                    },
                    "automaticUnlocked": False,
                    "override": {
                        "mode": "unlocked",
                        "changedAt": "2026-08-12T10:00:00.000Z",
                        "expiresAt": "2026-08-12T21:00:00.000Z",
                    },
                    "unlocked": False,
                }
            )

    def test_rejects_unlocked_state_with_unpassed_required_material(self) -> None:
        with self.assertRaisesRegex(ValueError, "противоречат"):
            parse_gate(
                {
                    "day": "2026-08-12",
                    "required": 3,
                    "completed": 3,
                    "remaining": 0,
                    "learning": {
                        "materialId": 7,
                        "required": True,
                        "passed": False,
                    },
                    "unlocked": True,
                }
            )

    def test_rejects_invalid_learning_state(self) -> None:
        with self.assertRaisesRegex(ValueError, "ссылаться на материал"):
            parse_gate(
                {
                    "day": "2026-08-12",
                    "required": 3,
                    "completed": 2,
                    "remaining": 1,
                    "learning": {
                        "materialId": None,
                        "required": True,
                        "passed": False,
                    },
                    "unlocked": False,
                }
            )

    def test_rejects_incomplete_or_invalid_override_contract(self) -> None:
        valid = {
            "day": "2026-08-12",
            "required": 3,
            "completed": 1,
            "remaining": 2,
            "learning": {
                "materialId": None,
                "required": False,
                "passed": False,
            },
            "automaticUnlocked": False,
            "override": {
                "mode": "unlocked",
                "changedAt": "2026-08-12T10:00:00.000Z",
                "expiresAt": "2026-08-12T21:00:00.000Z",
            },
            "unlocked": True,
        }
        cases: list[tuple[str, dict, str]] = []

        without_automatic = dict(valid)
        without_automatic.pop("automaticUnlocked")
        cases.append(("нет automaticUnlocked", without_automatic, "automaticUnlocked"))

        without_override = dict(valid)
        without_override.pop("override")
        cases.append(("нет override", without_override, "override"))

        wrong_automatic = dict(valid, automaticUnlocked="false")
        cases.append(("неверный тип automaticUnlocked", wrong_automatic, "логическим"))

        wrong_override_type = dict(valid, override=[])
        cases.append(("неверный тип override", wrong_override_type, "JSON-объектом"))

        for mode in ("automatic", 1):
            wrong_mode = dict(valid)
            wrong_mode["override"] = {**valid["override"], "mode": mode}
            cases.append((f"неверный mode {mode}", wrong_mode, "blocked или unlocked"))

        for missing in ("mode", "changedAt", "expiresAt"):
            incomplete = dict(valid)
            override = dict(valid["override"])
            override.pop(missing)
            incomplete["override"] = override
            cases.append((f"нет override.{missing}", incomplete, missing))

        without_timezone = dict(valid)
        without_timezone["override"] = {
            **valid["override"],
            "changedAt": "2026-08-12T10:00:00",
        }
        cases.append(("timestamp без timezone", without_timezone, "часовой пояс"))

        for expires_at in (
            "2026-08-12T10:00:00.000Z",
            "2026-08-12T09:59:59.999Z",
        ):
            invalid_order = dict(valid)
            invalid_order["override"] = {
                **valid["override"],
                "expiresAt": expires_at,
            }
            cases.append(("expiresAt не позже changedAt", invalid_order, "позже changedAt"))

        missing_day = dict(valid)
        missing_day.pop("day")
        cases.append(("нет обязательного поля", missing_day, "нет поля day"))

        for invalid_day in ("", "20260812", "2026-8-12", "2026-02-30"):
            malformed_day = dict(valid, day=invalid_day)
            cases.append(
                (f"неверный day {invalid_day}", malformed_day, "YYYY-MM-DD")
            )

        for name, payload, message in cases:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, message):
                parse_gate(payload)


UNLOCKED_PAYLOAD = {
    "day": "2026-08-12",
    "required": 3,
    "completed": 3,
    "remaining": 0,
    "learning": {"materialId": 7, "required": True, "passed": True},
    "automaticUnlocked": True,
    "override": None,
    "unlocked": True,
}


class _GateStubHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 — имя задано BaseHTTPRequestHandler
        server: Any = self.server
        server.requests.append((self.path, dict(self.headers)))
        if server.location is not None:
            self.send_response(server.status)
            self.send_header("Location", server.location)
            self.end_headers()
            return
        body = json.dumps(server.payload).encode("utf-8")
        self.send_response(server.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_arguments: Any) -> None:
        """Тишина: журнал http.server иначе засоряет вывод тестов."""


@contextmanager
def dripping_headers_stub() -> Iterator[Any]:
    """Собеседник, который бесконечно тянет заголовки, не доходя до тела.

    `100 Continue` раз в четверть сокетного срока: каждая строка обновляет
    сокетный таймаут, и без общего срока `getresponse()` не вернулся бы никогда.
    """
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    stop = threading.Event()

    def serve() -> None:
        try:
            connection, _ = listener.accept()
        except OSError:
            return
        try:
            while not stop.is_set():
                connection.sendall(b"HTTP/1.1 100 Continue\r\n\r\n")
                stop.wait(0.02)
        except OSError:
            pass
        finally:
            connection.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{listener.getsockname()[1]}"
    finally:
        stop.set()
        listener.close()
        thread.join(timeout=5)


@contextmanager
def gate_stub(
    *,
    status: int = 200,
    payload: Any = None,
    location: str | None = None,
) -> Iterator[Any]:
    """Локальный сервер gate/status: тесты не выходят за пределы машины."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _GateStubHandler)
    server.status = status
    server.payload = UNLOCKED_PAYLOAD if payload is None else payload
    server.location = location
    server.requests = []
    server.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@contextmanager
def environment(**values: str) -> Iterator[None]:
    """Переменные окружения на время теста, с восстановлением прежних."""
    previous = {name: os.environ.get(name) for name in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


class AgentTokenTests(unittest.IsolatedAsyncioTestCase):
    async def test_sends_agent_token_in_authorization_header(self) -> None:
        with gate_stub() as stub:
            gate = await fetch_gate(stub.url, AGENT_TOKEN)

        self.assertTrue(gate.unlocked)
        path, headers = stub.requests[0]
        self.assertEqual(path, "/api/gate/status")
        self.assertEqual(headers["Authorization"], f"Bearer {AGENT_TOKEN}")

    async def test_loop_sends_the_agent_token_and_never_the_refresh_token(self) -> None:
        # Прямой вызов `fetch_gate` проверяет только сборку заголовка: токен в
        # него кладёт сам тест. Здесь заголовок собирает `run_controller` — и
        # перепутанное поле конфигурации означало бы, что ключ от детского
        # аккаунта Microsoft уезжает на сервер Edukator в открытом виде.
        family = FakeFamily(blocked=True)

        async def stop_after_first_poll(_: float) -> None:
            raise asyncio.CancelledError

        with gate_stub() as stub:
            with self.assertRaises(asyncio.CancelledError):
                await run_controller(
                    ControllerConfig("refresh-token-secret", "child", AGENT_TOKEN, stub.url),
                    family,
                    sleep=stop_after_first_poll,
                    log=lambda _: None,
                )

        _, headers = stub.requests[0]
        self.assertEqual(headers["Authorization"], f"Bearer {AGENT_TOKEN}")
        self.assertNotIn("refresh-token-secret", "\n".join(headers.values()))

    async def test_oversized_body_is_refused_instead_of_being_read_whole(self) -> None:
        # На указанном адресе может оказаться что угодно: `json.load` читает
        # поток до конца, и бесконечная выдача чужой службы съела бы память.
        huge = dict(UNLOCKED_PAYLOAD, day="2026-08-12", override="x" * (MAX_GATE_BODY + 1))
        with gate_stub(payload=huge) as stub:
            with self.assertRaisesRegex(RuntimeError, "длиннее"):
                await fetch_gate(stub.url, AGENT_TOKEN)

    async def test_stalled_read_gives_up_instead_of_hanging_the_loop(self) -> None:
        # `timeout` у `urlopen` действует на отдельную операцию с сокетом:
        # собеседник, отдающий по байту раз в четыре секунды, продлевает чтение
        # бесконечно. Зависший здесь запрос оставил бы `run_controller` ждать
        # навечно — ни аварийная блокировка, ни истечение доступа не сработали
        # бы, и контроллер завис бы **открытым**.
        def stall(_url: str, _token: str, _timeout: float) -> GateState:
            time.sleep(0.5)
            return UNLOCKED

        original = gate_module._fetch_gate
        gate_module._fetch_gate = stall
        try:
            with self.assertRaisesRegex(RuntimeError, "не ответил"):
                await fetch_gate("http://127.0.0.1:1", AGENT_TOKEN, timeout=0.05)
        finally:
            gate_module._fetch_gate = original

    def test_stalled_headers_end_the_worker_thread_instead_of_wedging_it(self) -> None:
        # Тело — не единственное, что читается с сокета: статус и заголовки идут
        # до него, и их сокетный таймаут обновляется каждой строкой. Брошенный
        # `asyncio.wait_for` освобождает только ждущего, а поток остаётся на
        # сокете навсегда — пара таких за сутки опроса выедает пул `to_thread`,
        # и контроллер перестаёт замечать выздоровевший сервер, держа компьютер
        # закрытым. Проверяется поэтому сам `_fetch_gate`, а не `fetch_gate`:
        # снаружи срок держит `wait_for`, и он зелёный в любом случае.
        with dripping_headers_stub() as url:
            started = time.monotonic()
            with self.assertRaises(RuntimeError):
                gate_module._fetch_gate(url, AGENT_TOKEN, 0.2)
            spent = time.monotonic() - started

        self.assertLess(spent, 0.2 * gate_module.GATE_DEADLINE_FACTOR + 2)

    async def test_rejected_token_names_the_reason_without_printing_it(self) -> None:
        with gate_stub(status=401, payload={"error": "нет доступа"}) as stub:
            with self.assertRaises(RuntimeError) as failure:
                await fetch_gate(stub.url, AGENT_TOKEN)

        self.assertIn("агентский токен", str(failure.exception))
        self.assertNotIn(AGENT_TOKEN, str(failure.exception))

    async def test_forbidden_named_the_same_way_as_a_wrong_token(self) -> None:
        # Отозванное устройство сервер закрывает 401, а 403 достаётся живому
        # агенту, чьё устройство перестало быть агентским. Разбирая только 401,
        # контроллер отвечал бы «HTTP 403» — и родитель не узнал бы, что дело в
        # самом токене, а не в недоступном сервере.
        with gate_stub(status=403, payload={"error": "Доступ закрыт"}) as stub:
            with self.assertRaises(RuntimeError) as failure:
                await fetch_gate(stub.url, AGENT_TOKEN)

        self.assertIn("агентский токен", str(failure.exception))
        self.assertIn("новую ссылку", str(failure.exception))
        self.assertNotIn(AGENT_TOKEN, str(failure.exception))

    async def test_refused_answer_is_closed_instead_of_being_left_open(self) -> None:
        # `HTTPError` — открытый ответ, и бросает его сам `open`, то есть до
        # `with`. Отозванный токен даёт 401 на каждом опросе, а ошибка живёт
        # причиной у `RuntimeError` весь отступ: без закрытия это дескриптор на
        # опрос, и контроллер упирается в их предел, оставив компьютер как есть.
        body = io.BytesIO('{"error": "нет доступа"}'.encode())
        error = HTTPError(f"{EDUKATOR_URL}/api/gate/status", 401, "Unauthorized", Message(), body)

        class RefusingOpener:
            def open(self, request: Any, timeout: float | None = None) -> Any:
                raise error

        original = gate_module._OPENER
        gate_module._OPENER = RefusingOpener()
        try:
            with self.assertRaisesRegex(GateTokenRejected, "агентский токен"):
                await fetch_gate(EDUKATOR_URL, AGENT_TOKEN)
        finally:
            gate_module._OPENER = original

        self.assertTrue(body.closed)

    async def test_does_not_follow_redirect_with_the_token(self) -> None:
        with gate_stub() as elsewhere:
            with gate_stub(status=302, location=f"{elsewhere.url}/api/gate/status") as stub:
                with self.assertRaisesRegex(RuntimeError, "HTTP 302"):
                    await fetch_gate(stub.url, AGENT_TOKEN)

            self.assertEqual(elsewhere.requests, [])
            self.assertEqual(len(stub.requests), 1)

    async def test_does_not_hand_the_token_to_a_configured_proxy(self) -> None:
        # `_RefuseRedirect` закрывает увод токена через `Location`, но через
        # `http_proxy` его уносил бы умолчательный `ProxyHandler`: адрес
        # Edukator домашний и по документации простой http, а `no_proxy` его не
        # исключает — прокси получил бы `Authorization: Bearer` открытым текстом.
        with gate_stub() as proxy:
            with gate_stub() as stub:
                original = gate_module._OPENER
                with environment(http_proxy=proxy.url, no_proxy="", NO_PROXY=""):
                    gate_module._OPENER = gate_module._build_opener()
                    try:
                        gate = await fetch_gate(stub.url, AGENT_TOKEN)
                    finally:
                        gate_module._OPENER = original

            self.assertTrue(gate.unlocked)
            self.assertEqual(proxy.requests, [])
            self.assertEqual(len(stub.requests), 1)

    async def test_rejected_token_fails_closed_and_stays_out_of_the_log(self) -> None:
        family = FakeFamily(blocked=False)
        logs: list[str] = []

        async def stop_after_backoff(_: float) -> None:
            raise asyncio.CancelledError

        with gate_stub(status=401, payload={"error": "нет доступа"}) as stub:
            with self.assertRaises(asyncio.CancelledError):
                await run_controller(
                    ControllerConfig("refresh", "child", AGENT_TOKEN, stub.url),
                    family,
                    sleep=stop_after_backoff,
                    log=logs.append,
                )

        self.assertEqual(family.actions, [True])
        self.assertTrue(family.blocked)
        joined = "\n".join(logs)
        self.assertIn("агентский токен", joined)
        self.assertNotIn(AGENT_TOKEN, joined)

    async def test_revoked_token_closes_previously_unlocked_access(self) -> None:
        family = FakeFamily(blocked=True)
        reads = 0
        sleeps = 0

        async def reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                return UNLOCKED
            raise GateTokenRejected("Edukator не принял агентский токен (HTTP 401)")

        async def poll_once_then_stop(_: float) -> None:
            nonlocal sleeps
            sleeps += 1
            if sleeps == 2:
                raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=reader,
                sleep=poll_once_then_stop,
                wall_clock=lambda: datetime(2026, 8, 12, 12, tzinfo=timezone.utc),
                log=lambda _: None,
            )

        self.assertEqual(family.actions, [False, True])
        self.assertTrue(family.blocked)


class ConfigTests(unittest.TestCase):
    def test_round_trip_uses_owner_only_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            expected = ControllerConfig("secret", "child-id", AGENT_TOKEN, EDUKATOR_URL)
            save_config(expected, path)

            self.assertEqual(load_config(path), expected)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text())["refresh_token"], "secret")

    def test_saved_config_syncs_the_directory_and_not_just_the_file(self) -> None:
        # `fsync` файла несёт содержимое, но не запись каталога: после сбоя
        # питания вернулась бы прежняя конфигурация, а refresh token Microsoft
        # одноразовый — вернувшийся старый уже не примут, и вместо опроса гейта
        # родителя ждёт повторный `family:login`.
        synced: list[bool] = []
        real_fsync = os.fsync

        def recording(descriptor: int) -> None:
            synced.append(stat.S_ISDIR(os.fstat(descriptor).st_mode))
            real_fsync(descriptor)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "конфигурация" / "family.json"
            with mock.patch("edukator_family_controller.config.os.fsync", recording):
                save_config(ControllerConfig("secret", "child-id", AGENT_TOKEN, EDUKATOR_URL), path)

            self.assertEqual(load_config(path).agent_token, AGENT_TOKEN)

        self.assertIn(True, synced)
        self.assertIn(False, synced)

    def test_rejects_invalid_intervals(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            path.write_text(
                json.dumps(
                    {
                        "refresh_token": "secret",
                        "child_user_id": "child-id",
                        "agent_token": AGENT_TOKEN,
                        "edukator_url": EDUKATOR_URL,
                        "poll_seconds": 0,
                    }
                )
            )
            with self.assertRaisesRegex(ValueError, "Интервалы"):
                load_config(path)

    def test_requires_server_address_and_agent_token(self) -> None:
        complete = {
            "refresh_token": "secret",
            "child_user_id": "child-id",
            "agent_token": AGENT_TOKEN,
            "edukator_url": EDUKATOR_URL,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            for missing in ("agent_token", "edukator_url"):
                payload = {key: value for key, value in complete.items() if key != missing}
                path.write_text(json.dumps(payload))
                with self.subTest(missing=missing):
                    with self.assertRaisesRegex(ValueError, missing):
                        load_config(path)

    def test_agent_token_is_saved_but_never_shown(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            config = ControllerConfig("secret", "child-id", AGENT_TOKEN, EDUKATOR_URL)
            save_config(config, path)

            self.assertEqual(json.loads(path.read_text())["agent_token"], AGENT_TOKEN)
            shown = repr(load_config(path))
            self.assertNotIn(AGENT_TOKEN, shown)
            self.assertNotIn("secret", shown)
            self.assertIn("child-id", shown)

    def test_pending_login_is_private_and_can_be_resumed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            save_pending_login("resumable", path)

            self.assertEqual(load_pending_login(path), "resumable")
            self.assertEqual(os.stat(pending_login_path(path)).st_mode & 0o777, 0o600)
            clear_pending_login(path)
            self.assertIsNone(load_pending_login(path))


class ServerAccessPromptTests(unittest.TestCase):
    def test_asks_for_address_and_hidden_token_on_first_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            visible: list[str] = []

            url, token = ask_server_access(
                path,
                ask=lambda prompt: visible.append(prompt) or "https://edu.example.com/",
                ask_secret=lambda _: AGENT_TOKEN,
            )

            self.assertEqual(url, "https://edu.example.com")
            self.assertEqual(token, AGENT_TOKEN)
            # Токен спрашивают только скрытым вводом: подсказки открытого ввода
            # о нём даже не упоминают.
            self.assertNotIn("токен", " ".join(visible).lower())

    def test_keeps_previous_values_on_empty_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            save_config(ControllerConfig("secret", "child-id", AGENT_TOKEN, EDUKATOR_URL), path)

            url, token = ask_server_access(path, ask=lambda _: "", ask_secret=lambda _: "  ")

            self.assertEqual(url, EDUKATOR_URL)
            self.assertEqual(token, AGENT_TOKEN)

    def test_offers_previous_address_when_config_predates_new_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            # Конфигурация прошлой версии: `agent_token` в ней ещё нет, и
            # строгое чтение отказывает целиком — то есть ровно на обновлении,
            # где README обещает прежний адрес. Без нестрогого чтения Enter в
            # ответ на вопрос падал бы «адрес должен начинаться с http://»
            # после всего входа Microsoft, назвав виноватым ввод.
            path.write_text(
                json.dumps({
                    "refresh_token": "старый",
                    "child_user_id": "child-id",
                    "edukator_url": EDUKATOR_URL,
                }),
                encoding="utf-8",
            )
            prompts: list[str] = []

            url, token = ask_server_access(
                path,
                ask=lambda prompt: prompts.append(prompt) or "",
                ask_secret=lambda _: AGENT_TOKEN,
            )

            self.assertEqual(url, EDUKATOR_URL)
            self.assertEqual(token, AGENT_TOKEN)
            self.assertIn(EDUKATOR_URL, prompts[0])

    def test_does_not_promise_a_previous_token_that_does_not_exist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            path.write_text(
                json.dumps({
                    "refresh_token": "старый",
                    "child_user_id": "child-id",
                    "edukator_url": EDUKATOR_URL,
                }),
                encoding="utf-8",
            )
            secret_prompts: list[str] = []

            # Прежнего агентского токена в такой конфигурации нет: «Enter —
            # оставить прежний» отправлял бы нажимать Enter в пустоту.
            with self.assertRaisesRegex(ValueError, "токен"):
                ask_server_access(
                    path,
                    ask=lambda _: "",
                    ask_secret=lambda prompt: secret_prompts.append(prompt) or "",
                )

            self.assertNotIn("прежний", " ".join(secret_prompts))

    def test_previous_access_ignores_junk_without_losing_the_neighbour(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            path.write_text(
                json.dumps({"edukator_url": "   ", "agent_token": AGENT_TOKEN}),
                encoding="utf-8",
            )

            self.assertEqual(read_previous_access(path), {"agent_token": AGENT_TOKEN})
            self.assertEqual(read_previous_access(Path(directory) / "нет.json"), {})

    def test_rotation_keeps_tuned_intervals(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            tuned = ControllerConfig(
                "secret",
                "child-id",
                AGENT_TOKEN,
                EDUKATOR_URL,
                poll_seconds=45.0,
                verify_seconds=600.0,
                block_days=14,
            )
            save_config(tuned, path)

            # Повторный family:login меняет токены, но не настройки опроса:
            # собранная с нуля конфигурация молча вернула бы их к умолчаниям.
            updated = merged_config(
                path,
                refresh_token="новый",
                child_user_id="child-id",
                agent_token="новый-агент",
                edukator_url=EDUKATOR_URL,
            )

            self.assertEqual(updated.refresh_token, "новый")
            self.assertEqual(updated.agent_token, "новый-агент")
            self.assertEqual(updated.poll_seconds, 45.0)
            self.assertEqual(updated.verify_seconds, 600.0)
            self.assertEqual(updated.block_days, 14)

    def test_rotation_keeps_tuned_intervals_when_config_predates_new_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            # Конфигурация прошлой версии: `agent_token` и `edukator_url` в ней
            # ещё не обязательны, потому этот `family:login` и запускают.
            # Строгий `load_config` на ней отказывает целиком — и все три
            # настройки молча вернулись бы к умолчаниям.
            path.write_text(
                json.dumps({
                    "refresh_token": "старый",
                    "child_user_id": "child-id",
                    "poll_seconds": 45,
                    "verify_seconds": 600,
                    "block_days": 14,
                }),
                encoding="utf-8",
            )

            updated = merged_config(
                path,
                refresh_token="новый",
                child_user_id="child-id",
                agent_token=AGENT_TOKEN,
                edukator_url=EDUKATOR_URL,
            )

            self.assertEqual(updated.poll_seconds, 45.0)
            self.assertEqual(updated.verify_seconds, 600.0)
            self.assertEqual(updated.block_days, 14)
            self.assertEqual(updated.agent_token, AGENT_TOKEN)

    def test_unreadable_settings_fall_back_to_defaults_one_by_one(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            path.write_text(
                json.dumps({"poll_seconds": None, "verify_seconds": 600}),
                encoding="utf-8",
            )

            # Испорченное значение не должно уносить с собой соседнее.
            self.assertEqual(read_poll_settings(path), {"verify_seconds": 600.0})
            self.assertEqual(read_poll_settings(Path(directory) / "нет.json"), {})

    def test_out_of_range_settings_fall_back_to_defaults_instead_of_being_saved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            path.write_text(
                json.dumps({"poll_seconds": 0, "verify_seconds": -1, "block_days": 0}),
                encoding="utf-8",
            )

            # Иначе значение вне границ переживает весь вход в Microsoft, вход
            # отчитывается «Конфигурация сохранена» и стирает начатую сессию — а
            # `start:family` следом отказывает «Интервалы опроса должны быть
            # положительными», и виноватым выглядит не тот шаг.
            self.assertEqual(read_poll_settings(path), {})

            updated = merged_config(
                path,
                refresh_token="secret",
                child_user_id="child-id",
                agent_token=AGENT_TOKEN,
                edukator_url=EDUKATOR_URL,
            )
            self.assertEqual(updated.poll_seconds, 20.0)
            self.assertEqual(updated.verify_seconds, 300.0)
            self.assertEqual(updated.block_days, 7)

    def test_config_directory_is_private_even_when_it_already_exists(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "конфиг"
            home.mkdir(mode=0o755)
            path = home / "family.json"

            save_config(
                ControllerConfig("secret", "child-id", AGENT_TOKEN, EDUKATOR_URL), path
            )

            # В каталоге лежат refresh token, агентский токен и времянка
            # `mkstemp` с предсказуемым именем: `mkdir(mode=...)` уже
            # существующий каталог не трогает вовсе.
            self.assertEqual(home.stat().st_mode & 0o777, 0o700)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_non_numeric_interval_is_named_instead_of_crashing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            # `None` и список дают `TypeError`, а не `ValueError`: без приведения
            # он улетал бы трассировкой мимо всех `except ValueError`.
            path.write_text(
                json.dumps({
                    "refresh_token": "secret",
                    "child_user_id": "child-id",
                    "agent_token": AGENT_TOKEN,
                    "edukator_url": EDUKATOR_URL,
                    "poll_seconds": None,
                }),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "poll_seconds"):
                load_config(path)

    def test_first_login_needs_no_previous_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"

            updated = merged_config(
                path,
                refresh_token="secret",
                child_user_id="child-id",
                agent_token=AGENT_TOKEN,
                edukator_url=EDUKATOR_URL,
            )

            self.assertEqual(
                updated, ControllerConfig("secret", "child-id", AGENT_TOKEN, EDUKATOR_URL)
            )

    def test_rejects_address_without_scheme_and_empty_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            with self.assertRaisesRegex(ValueError, "http://"):
                ask_server_access(path, ask=lambda _: "edu.example.com", ask_secret=lambda _: "t")
            with self.assertRaisesRegex(ValueError, "токен"):
                ask_server_access(
                    path,
                    ask=lambda _: "https://edu.example.com",
                    ask_secret=lambda _: "",
                )


class FlakyRoster:
    def __init__(self, failures: int) -> None:
        self.failures = failures
        self.calls = 0
        self.accounts: list[object] = []

    async def update(self) -> None:
        self.calls += 1
        if self.calls <= self.failures:
            raise OSError("temporary network error")
        self.accounts = [object()]


class LoginRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_transient_family_safety_failure(self) -> None:
        family = FlakyRoster(failures=2)
        delays: list[float] = []

        await update_family_with_retry(
            family,
            sleep=lambda delay: self._record_delay(delays, delay),
            log=lambda _: None,
        )

        self.assertEqual(family.calls, 3)
        self.assertEqual(delays, [1, 2])

    async def test_keeps_clear_resume_instruction_after_last_failure(self) -> None:
        family = FlakyRoster(failures=5)

        with self.assertRaisesRegex(RuntimeError, "запустите family:login ещё раз"):
            await update_family_with_retry(
                family,
                attempts=3,
                sleep=lambda _: self._record_delay([], 0),
                log=lambda _: None,
            )

    @staticmethod
    async def _record_delay(delays: list[float], delay: float) -> None:
        delays.append(delay)


class MinimalFamilyRefreshTests(unittest.IsolatedAsyncioTestCase):
    async def test_loads_only_selected_child_and_accepts_numeric_user_id(self) -> None:
        class FakeApi:
            def __init__(self) -> None:
                self.calls: list[str] = []
                self.override_body: dict | None = None

            async def async_get_accounts(self) -> dict:
                self.calls.append("roster")
                return {
                    "json": {
                        "members": [
                            {
                                "id": 844431448756706,
                                "isDigitalSafetyEnabled": True,
                                "role": "Member",
                                "user": {"firstName": "Ilya", "lastName": "S"},
                            }
                        ]
                    }
                }

            async def async_get_user_devices(self, user_id: int) -> dict:
                self.calls.append("devices")
                self.assert_child(user_id)
                return {
                    "json": {
                        "devices": [
                            {
                                "deviceId": "g:pc",
                                "deviceName": "GAMING-DESKTOP",
                                "osName": "Windows",
                            }
                        ]
                    }
                }

            async def async_get_override_device_restrictions(
                self, user_id: int
            ) -> dict:
                self.calls.append("overrides")
                self.assert_child(user_id)
                return {
                    "json": {
                        "lockablePlatforms": [
                            {
                                "appliesTo": "Windows",
                                "overrides": [],
                                "devices": [],
                            }
                        ]
                    }
                }

            async def async_override_device_restriction(
                self, user_id: int, body: dict
            ) -> dict:
                self.calls.append("set-override")
                self.assert_child(user_id)
                self.override_body = body
                return {"json": {}}

            @staticmethod
            def assert_child(user_id: int) -> None:
                if user_id != 844431448756706:
                    raise AssertionError(f"unexpected user ID: {user_id}")

        class FakeAuth:
            refresh_token = "refresh"

        class FakeRoster:
            def __init__(self) -> None:
                self._api = FakeApi()
                self.accounts: list[object] = []

        roster = FakeRoster()
        client = MicrosoftFamilyClient(
            FakeAuth(), roster, "844431448756706", block_days=7
        )

        await client.refresh()
        await client.refresh()
        await client.set_desktop_blocked(True)

        self.assertEqual(
            roster._api.calls,
            ["roster", "devices", "overrides", "overrides", "set-override"],
        )
        self.assertEqual(roster._api.override_body["target"], "Windows")
        self.assertTrue(client.is_desktop_blocked())


class ReconcileTests(unittest.IsolatedAsyncioTestCase):
    async def test_blocks_when_plan_is_not_complete(self) -> None:
        family = FakeFamily(blocked=False)
        state = ReconcileState()
        logs: list[str] = []

        await reconcile(LOCKED, family, state, 10, 300, logs.append)

        self.assertEqual(family.actions, [True])
        self.assertIn("заблокирован", logs[0])
        self.assertIsNone(state.access_expires_at)

    async def test_unlocks_after_third_run_and_is_idempotent(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState()

        await reconcile(UNLOCKED, family, state, 10, 300, lambda _: None)
        await reconcile(UNLOCKED, family, state, 20, 300, lambda _: None)

        self.assertEqual(family.actions, [False])
        self.assertEqual(family.refreshes, 1)

    async def test_confirmed_unlock_clears_block_renewal_marker(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState(block_renewed_at=5)

        await reconcile(UNLOCKED, family, state, 10, 300, lambda _: None)

        self.assertIsNone(state.block_renewed_at)
        self.assertFalse(state.block_renewal_uncertain)

        # An independently-created short block must not be mistaken for the old
        # controller-owned UNTIL when the server asks to block again.
        family.blocked = True
        await reconcile(LOCKED, family, state, 20, 300, lambda _: None)

        self.assertEqual(family.actions, [False, True])
        self.assertEqual(state.block_renewed_at, 20)

    async def test_unblocked_noop_clears_block_renewal_marker(self) -> None:
        family = FakeFamily(blocked=False)
        state = ReconcileState(
            actual_blocked=False,
            desired_blocked=False,
            verified_at=10,
            block_renewed_at=5,
        )

        await reconcile(UNLOCKED, family, state, 20, 300, lambda _: None)

        self.assertEqual(family.actions, [])
        self.assertIsNone(state.block_renewed_at)
        self.assertFalse(state.block_renewal_uncertain)

    async def test_ambiguous_unlock_keeps_but_invalidates_marker_until_retry(
        self,
    ) -> None:
        gate = forced_unlocked_gate()
        for applied_before_failure in (False, True):
            with self.subTest(applied=applied_before_failure):
                family = FailFirstUnlockFamily(
                    blocked=True,
                    apply_before_failure=applied_before_failure,
                )
                state = ReconcileState(block_renewed_at=5)

                with self.assertRaisesRegex(RuntimeError, "response lost"):
                    await reconcile(gate, family, state, 10, 300, lambda _: None)

                self.assertEqual(state.block_renewed_at, 5)
                self.assertTrue(state.block_renewal_uncertain)

                await reconcile(gate, family, state, 20, 300, lambda _: None)

                self.assertEqual(family.actions, [False])
                self.assertIsNone(state.block_renewed_at)
                self.assertFalse(state.block_renewal_uncertain)

    async def test_locked_gate_reapplies_after_ambiguous_unlock(self) -> None:
        family = FailFirstUnlockFamily(blocked=True, apply_before_failure=True)
        state = ReconcileState(
            actual_blocked=True,
            desired_blocked=True,
            verified_at=5,
            block_renewed_at=5,
        )

        with self.assertRaisesRegex(RuntimeError, "response lost"):
            await reconcile(
                forced_unlocked_gate(),
                family,
                state,
                10,
                300,
                lambda _: None,
            )

        await reconcile(LOCKED, family, state, 20, 300, lambda _: None)

        self.assertEqual(family.actions, [False, True])
        self.assertEqual(state.block_renewed_at, 20)
        self.assertFalse(state.block_renewal_uncertain)

    async def test_applies_both_forced_states_through_effective_gate(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState()
        forced_unlocked = parse_gate(
            {
                "day": "2026-08-12",
                "required": 3,
                "completed": 0,
                "remaining": 3,
                "learning": {
                    "materialId": None,
                    "required": False,
                    "passed": False,
                },
                "automaticUnlocked": False,
                "override": {
                    "mode": "unlocked",
                    "changedAt": "2026-08-12T10:00:00.000Z",
                    "expiresAt": "2026-08-12T21:00:00.000Z",
                },
                "unlocked": True,
            }
        )
        forced_blocked = parse_gate(
            {
                "day": "2026-08-12",
                "required": 3,
                "completed": 3,
                "remaining": 0,
                "learning": {
                    "materialId": None,
                    "required": False,
                    "passed": False,
                },
                "automaticUnlocked": True,
                "override": {
                    "mode": "blocked",
                    "changedAt": "2026-08-12T10:01:00.000Z",
                    "expiresAt": "2026-08-12T21:00:00.000Z",
                },
                "unlocked": False,
            }
        )

        await reconcile(forced_unlocked, family, state, 10, 300, lambda _: None)
        await reconcile(forced_blocked, family, state, 20, 300, lambda _: None)

        self.assertEqual(family.actions, [False, True])
        self.assertIsNone(state.access_expires_at)

    async def test_failed_authoritative_apply_retains_unlocked_override_deadline(
        self,
    ) -> None:
        deadline = datetime(2026, 8, 12, 21, tzinfo=timezone.utc)
        family = FailFirstBlockFamily(blocked=False)
        state = ReconcileState(
            actual_blocked=False,
            desired_blocked=False,
            verified_at=10,
            access_expires_at=deadline,
        )

        with self.assertRaisesRegex(RuntimeError, "apply failed"):
            await reconcile(LOCKED, family, state, 20, 300, lambda _: None)

        self.assertEqual(state.access_expires_at, deadline)

        await reconcile(LOCKED, family, state, 30, 300, lambda _: None)

        self.assertIsNone(state.access_expires_at)
        self.assertTrue(family.blocked)

    async def test_forced_unlock_arms_deadline_before_pure_failure_and_retry(
        self,
    ) -> None:
        gate = forced_unlocked_gate()
        family = FailFirstUnlockFamily(blocked=True)
        state = ReconcileState()

        with self.assertRaisesRegex(RuntimeError, "response lost"):
            await reconcile(gate, family, state, 10, 300, lambda _: None)

        self.assertEqual(
            state.access_expires_at,
            gate.override.expires_at,
        )
        self.assertTrue(family.blocked)

        await reconcile(gate, family, state, 20, 300, lambda _: None)

        self.assertEqual(family.unlock_attempts, 2)
        self.assertEqual(family.actions, [False])
        self.assertEqual(
            state.access_expires_at,
            gate.override.expires_at,
        )

    async def test_forced_unlock_arms_deadline_before_refresh_and_on_noop(
        self,
    ) -> None:
        gate = forced_unlocked_gate()
        failing_family = FailFirstRefreshFamily(blocked=True)
        failed_state = ReconcileState()

        with self.assertRaisesRegex(RuntimeError, "refresh failed"):
            await reconcile(
                gate,
                failing_family,
                failed_state,
                10,
                300,
                lambda _: None,
            )

        self.assertEqual(
            failed_state.access_expires_at,
            gate.override.expires_at,
        )

        noop_family = FakeFamily(blocked=False)
        noop_state = ReconcileState(
            actual_blocked=False,
            desired_blocked=False,
            verified_at=10,
        )
        await reconcile(gate, noop_family, noop_state, 20, 300, lambda _: None)

        self.assertEqual(noop_family.refreshes, 0)
        self.assertEqual(noop_family.actions, [])
        self.assertEqual(
            noop_state.access_expires_at,
            gate.override.expires_at,
        )

    async def test_successful_automatic_unlocked_noop_sets_day_deadline(
        self,
    ) -> None:
        family = FakeFamily(blocked=False)
        state = ReconcileState(
            actual_blocked=False,
            desired_blocked=False,
            verified_at=10,
            access_expires_at=datetime(
                2026, 8, 12, 21, tzinfo=timezone.utc
            ),
        )

        await reconcile(UNLOCKED, family, state, 20, 300, lambda _: None)

        self.assertEqual(family.actions, [])
        self.assertEqual(
            state.access_expires_at,
            datetime(2026, 8, 12, 21, tzinfo=timezone.utc),
        )

    async def test_periodic_verification_restores_manual_unblock(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState()
        await reconcile(LOCKED, family, state, 10, 300, lambda _: None)
        family.blocked = False

        await reconcile(LOCKED, family, state, 400, 300, lambda _: None)

        self.assertEqual(family.actions, [True, True])
        self.assertEqual(family.refreshes, 2)

    async def test_normal_reconcile_renews_block_at_safe_interval(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState()

        await reconcile(LOCKED, family, state, 10, 300, lambda _: None)
        await reconcile(
            LOCKED,
            family,
            state,
            10 + BLOCK_RENEW_SECONDS - 1,
            300,
            lambda _: None,
        )
        await reconcile(
            LOCKED,
            family,
            state,
            10 + BLOCK_RENEW_SECONDS,
            300,
            lambda _: None,
        )

        self.assertEqual(family.actions, [True, True])
        self.assertEqual(state.block_renewed_at, 10 + BLOCK_RENEW_SECONDS)
        self.assertFalse(state.block_renewal_uncertain)

    async def test_long_locked_poll_wakes_for_block_renewal(self) -> None:
        family = FakeFamily(blocked=True)
        monotonic = 100.0
        delays: list[float] = []

        async def sleep_through_one_renewal(delay: float) -> None:
            nonlocal monotonic
            delays.append(delay)
            monotonic += delay
            if len(delays) > 1:
                raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig(
                    "refresh",
                    "child",
                    AGENT_TOKEN,
                    EDUKATOR_URL,
                    poll_seconds=2 * BLOCK_RENEW_SECONDS,
                ),
                family,
                gate_reader=lambda *_: self._gate(LOCKED),
                sleep=sleep_through_one_renewal,
                clock=lambda: monotonic,
                log=lambda _: None,
            )

        self.assertEqual(delays, [BLOCK_RENEW_SECONDS, BLOCK_RENEW_SECONDS])
        self.assertEqual(family.actions, [True, True])

    async def test_small_locked_poll_is_not_extended(self) -> None:
        family = FakeFamily(blocked=True)
        delays: list[float] = []

        async def record_then_stop(delay: float) -> None:
            delays.append(delay)
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL, poll_seconds=60),
                family,
                gate_reader=lambda *_: self._gate(LOCKED),
                sleep=record_then_stop,
                clock=lambda: 100,
                log=lambda _: None,
            )

        self.assertEqual(delays, [60])

    def test_overdue_block_renewal_uses_minimum_wake_delay(self) -> None:
        state = ReconcileState(
            desired_blocked=True,
            block_renewed_at=100,
        )

        delay = cap_delay_to_safety_wake(
            90_000,
            state,
            datetime(2026, 8, 12, tzinfo=timezone.utc),
            101 + BLOCK_RENEW_SECONDS,
        )

        self.assertEqual(delay, 1.0)

    async def test_fail_closed_refreshes_before_proactive_renewal(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState(block_renewed_at=100)

        await ensure_fail_closed(
            family,
            state,
            100 + BLOCK_RENEW_SECONDS - 1,
            lambda _: None,
            "test outage",
        )

        self.assertEqual(family.refreshes, 1)
        self.assertEqual(family.actions, [])
        self.assertEqual(state.block_renewed_at, 100)

    async def test_fail_closed_proactively_renews_existing_block(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState(block_renewed_at=100)

        await ensure_fail_closed(
            family,
            state,
            100 + BLOCK_RENEW_SECONDS,
            lambda _: None,
            "test long outage",
        )

        self.assertEqual(family.refreshes, 1)
        self.assertEqual(family.actions, [True])
        self.assertEqual(state.block_renewed_at, 100 + BLOCK_RENEW_SECONDS)

    async def test_failed_fail_closed_renewal_keeps_timestamp_and_retries(
        self,
    ) -> None:
        family = FailFirstBlockFamily(blocked=True)
        state = ReconcileState(block_renewed_at=100)

        with self.assertRaisesRegex(RuntimeError, "apply failed"):
            await ensure_fail_closed(
                family,
                state,
                100 + BLOCK_RENEW_SECONDS,
                lambda _: None,
                "test failed renewal",
            )

        self.assertEqual(state.block_renewed_at, 100)

        await ensure_fail_closed(
            family,
            state,
            101 + BLOCK_RENEW_SECONDS,
            lambda _: None,
            "test retry",
        )

        self.assertEqual(family.block_attempts, 2)
        self.assertEqual(family.actions, [True])
        self.assertEqual(state.block_renewed_at, 101 + BLOCK_RENEW_SECONDS)

    async def test_unavailable_edukator_on_startup_verifies_safe_block(self) -> None:
        family = FakeFamily(blocked=True)

        async def failing_reader(_: str, __: str) -> GateState:
            raise RuntimeError("нет связи")

        async def stop_after_backoff(_: float) -> None:
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=failing_reader,
                sleep=stop_after_backoff,
                log=lambda _: None,
            )

        self.assertEqual(family.refreshes, 1)
        self.assertEqual(family.actions, [True])
        self.assertTrue(family.closed)

    async def test_invalid_first_gate_still_fails_closed_on_startup(self) -> None:
        family = FakeFamily(blocked=False)
        logs: list[str] = []

        async def invalid_reader(_: str, __: str) -> GateState:
            raise ValueError("invalid gate payload")

        async def stop_after_backoff(_: float) -> None:
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=invalid_reader,
                sleep=stop_after_backoff,
                log=logs.append,
            )

        self.assertEqual(family.actions, [True])
        self.assertIn("ещё не подтвердил состояние после запуска", "\n".join(logs))

    async def test_first_locked_gate_fails_closed_after_refresh_error(self) -> None:
        family = FailFirstRefreshFamily(blocked=False)
        logs: list[str] = []

        async def stop_after_backoff(_: float) -> None:
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=lambda *_: self._gate(LOCKED),
                sleep=stop_after_backoff,
                log=logs.append,
            )

        self.assertEqual(family.refreshes, 2)
        self.assertEqual(family.actions, [True])
        self.assertTrue(family.blocked)
        self.assertIn("подтвердил требование блокировки", "\n".join(logs))

    async def test_locked_gate_retries_safety_during_edukator_outage(self) -> None:
        family = FailFirstBlockFamily(blocked=False, failures=2)
        reads = 0
        sleeps = 0

        async def reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                return LOCKED
            raise RuntimeError("нет связи")

        async def recover_then_stop(_: float) -> None:
            nonlocal sleeps
            sleeps += 1
            if sleeps > 1:
                raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=reader,
                sleep=recover_then_stop,
                log=lambda _: None,
            )

        self.assertEqual(family.block_attempts, 3)
        self.assertEqual(family.actions, [True])
        self.assertTrue(family.blocked)

    async def test_automatic_unlock_is_not_cancelled_after_ambiguous_apply(
        self,
    ) -> None:
        family = FailFirstUnlockFamily(blocked=True, apply_before_failure=True)
        current = datetime(2026, 8, 12, 20, tzinfo=timezone.utc)
        reads = 0
        blocked_during_sleeps: list[bool] = []

        async def reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                return UNLOCKED
            raise RuntimeError("нет связи")

        async def outage_then_stop(_: float) -> None:
            blocked_during_sleeps.append(family.blocked)
            if len(blocked_during_sleeps) > 1:
                raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=reader,
                sleep=outage_then_stop,
                wall_clock=lambda: current,
                log=lambda _: None,
            )

        self.assertEqual(family.actions, [False])
        self.assertEqual(blocked_during_sleeps, [False, False])
        self.assertFalse(family.blocked)

    async def test_normal_startup_uses_gate_without_intermediate_safe_block(self) -> None:
        family = FakeFamily(blocked=True)

        async def stop_after_poll(_: float) -> None:
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=lambda *_: self._gate(UNLOCKED),
                sleep=stop_after_poll,
                wall_clock=lambda: datetime(
                    2026, 8, 12, 20, tzinfo=timezone.utc
                ),
                log=lambda _: None,
            )

        self.assertEqual(family.actions, [False])
        self.assertEqual(family.refreshes, 1)

    async def test_startup_recovers_from_safe_block_when_api_returns(self) -> None:
        family = FakeFamily(blocked=False)
        reads = 0
        sleeps = 0

        async def recovering_reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                raise RuntimeError("нет связи")
            return UNLOCKED

        async def retry_then_stop(_: float) -> None:
            nonlocal sleeps
            sleeps += 1
            if sleeps > 1:
                raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=recovering_reader,
                sleep=retry_then_stop,
                wall_clock=lambda: datetime(
                    2026, 8, 12, 20, tzinfo=timezone.utc
                ),
                log=lambda _: None,
            )

        self.assertEqual(family.actions, [True, False])
        self.assertEqual(family.refreshes, 2)

    async def test_expired_unlocked_override_blocks_when_edukator_is_unavailable(self) -> None:
        family = FakeFamily(blocked=True)
        forced_unlocked = parse_gate(
            {
                "day": "2026-08-12",
                "required": 3,
                "completed": 0,
                "remaining": 3,
                "learning": {
                    "materialId": None,
                    "required": False,
                    "passed": False,
                },
                "automaticUnlocked": False,
                "override": {
                    "mode": "unlocked",
                    "changedAt": "2026-08-12T20:59:00.000Z",
                    "expiresAt": "2026-08-12T21:00:00.000Z",
                },
                "unlocked": True,
            }
        )
        current = datetime(2026, 8, 12, 20, 59, tzinfo=timezone.utc)
        reads = 0
        sleeps = 0

        async def reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                return forced_unlocked
            raise RuntimeError("нет связи")

        async def advance_or_stop(_: float) -> None:
            nonlocal current, sleeps
            sleeps += 1
            if sleeps == 1:
                current = datetime(2026, 8, 12, 21, tzinfo=timezone.utc)
                return
            raise asyncio.CancelledError

        logs: list[str] = []
        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=reader,
                sleep=advance_or_stop,
                wall_clock=lambda: current,
                log=logs.append,
            )

        self.assertEqual(family.actions, [False, True])
        self.assertIn("срок разрешённого доступа истёк", "\n".join(logs))
        self.assertTrue(family.closed)

    async def test_automatic_and_legacy_access_expire_at_moscow_midnight(
        self,
    ) -> None:
        for name, gate in (
            ("new", UNLOCKED),
            ("legacy", legacy_unlocked_gate()),
        ):
            with self.subTest(contract=name):
                family = FakeFamily(blocked=True)
                current = datetime(
                    2026, 8, 12, 20, 59, 59, tzinfo=timezone.utc
                )
                reads = 0
                delays: list[float] = []

                async def reader(_: str, __: str) -> GateState:
                    nonlocal reads
                    reads += 1
                    if reads == 1:
                        return gate
                    raise RuntimeError("нет связи")

                async def reach_midnight_then_stop(delay: float) -> None:
                    nonlocal current
                    delays.append(delay)
                    current += timedelta(seconds=delay)
                    if len(delays) > 1:
                        raise asyncio.CancelledError

                with self.assertRaises(asyncio.CancelledError):
                    await run_controller(
                        ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                        family,
                        gate_reader=reader,
                        sleep=reach_midnight_then_stop,
                        wall_clock=lambda: current,
                        log=lambda _: None,
                    )

                self.assertEqual(delays[0], 1.0)
                self.assertEqual(family.actions, [False, True])
                self.assertTrue(family.blocked)

    async def test_expired_access_block_is_maintained_during_outage(self) -> None:
        family = FakeFamily(blocked=True)
        current = datetime(2026, 8, 12, 20, 59, 59, tzinfo=timezone.utc)
        reads = 0
        action_counts: list[int] = []

        async def reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                return UNLOCKED
            raise RuntimeError("нет связи")

        async def expire_remove_then_stop(delay: float) -> None:
            nonlocal current
            action_counts.append(len(family.actions))
            if len(action_counts) == 1:
                current += timedelta(seconds=delay)
            elif len(action_counts) == 3:
                # Имитирует окончание конечного Family Safety UNTIL.
                family.blocked = False
            elif len(action_counts) > 3:
                raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=reader,
                sleep=expire_remove_then_stop,
                wall_clock=lambda: current,
                log=lambda _: None,
            )

        self.assertEqual(action_counts, [1, 2, 2, 3])
        self.assertEqual(family.actions, [False, True, True])
        self.assertEqual(family.refreshes, 4)
        self.assertTrue(family.blocked)

    async def test_expired_access_block_is_renewed_during_long_outage(
        self,
    ) -> None:
        family = FakeFamily(blocked=True)
        current = datetime(2026, 8, 12, 20, 59, 59, tzinfo=timezone.utc)
        monotonic = 0.0
        reads = 0
        sleeps = 0

        async def reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                return UNLOCKED
            raise RuntimeError("нет связи")

        async def advance_to_renewal(delay: float) -> None:
            nonlocal current, monotonic, sleeps
            sleeps += 1
            if sleeps == 1:
                current += timedelta(seconds=delay)
                monotonic = 10
            elif sleeps == 2:
                monotonic = 10 + BLOCK_RENEW_SECONDS - 1
            elif sleeps == 3:
                monotonic = 10 + BLOCK_RENEW_SECONDS
            else:
                raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=reader,
                sleep=advance_to_renewal,
                clock=lambda: monotonic,
                wall_clock=lambda: current,
                log=lambda _: None,
            )

        self.assertEqual(family.actions, [False, True, True])
        self.assertEqual(family.refreshes, 4)
        self.assertTrue(family.blocked)

    async def test_fresh_unlocked_gate_supersedes_local_expiry_block(self) -> None:
        next_day_automatic = GateState(
            day="2026-08-13",
            required=3,
            completed=3,
            remaining=0,
            learning=UNLOCKED.learning,
            automatic_unlocked=True,
            override=None,
            unlocked=True,
        )
        next_day_forced = forced_unlocked_gate(
            day="2026-08-13",
            changed_at="2026-08-12T21:00:00.000Z",
            expires_at="2026-08-13T21:00:00.000Z",
        )

        for name, recovered_gate in (
            ("automatic", next_day_automatic),
            ("forced", next_day_forced),
        ):
            with self.subTest(mode=name):
                family = FakeFamily(blocked=True)
                current = datetime(
                    2026, 8, 12, 20, 59, 59, tzinfo=timezone.utc
                )
                reads = 0
                blocked_during_sleeps: list[bool] = []

                async def reader(_: str, __: str) -> GateState:
                    nonlocal reads
                    reads += 1
                    if reads == 1:
                        return UNLOCKED
                    if reads == 2:
                        raise RuntimeError("нет связи")
                    return recovered_gate

                async def recover_then_stop(delay: float) -> None:
                    nonlocal current
                    blocked_during_sleeps.append(family.blocked)
                    if len(blocked_during_sleeps) == 1:
                        current += timedelta(seconds=delay)
                    elif len(blocked_during_sleeps) > 2:
                        raise asyncio.CancelledError

                with self.assertRaises(asyncio.CancelledError):
                    await run_controller(
                        ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                        family,
                        gate_reader=reader,
                        sleep=recover_then_stop,
                        wall_clock=lambda: current,
                        log=lambda _: None,
                    )

                self.assertEqual(blocked_during_sleeps, [False, True, False])
                self.assertEqual(family.actions, [False, True, False])
                self.assertFalse(family.blocked)

    async def test_forced_unlock_poll_is_capped_to_override_expiry(self) -> None:
        family = FakeFamily(blocked=True)
        forced_unlocked = forced_unlocked_gate()
        current = datetime(2026, 8, 12, 20, 59, 59, tzinfo=timezone.utc)
        reads = 0
        delays: list[float] = []

        async def reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                return forced_unlocked
            raise RuntimeError("нет связи")

        async def reach_expiry_then_stop(delay: float) -> None:
            nonlocal current
            delays.append(delay)
            current += timedelta(seconds=delay)
            if len(delays) > 1:
                raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=reader,
                sleep=reach_expiry_then_stop,
                wall_clock=lambda: current,
                log=lambda _: None,
            )

        self.assertEqual(delays[0], 1.0)
        self.assertEqual(family.actions, [False, True])
        self.assertTrue(family.blocked)

    async def test_failed_locked_apply_fails_closed_immediately(self) -> None:
        family = FailFirstBlockFamily(blocked=True)
        forced_unlocked = parse_gate(
            {
                "day": "2026-08-12",
                "required": 3,
                "completed": 0,
                "remaining": 3,
                "learning": {
                    "materialId": None,
                    "required": False,
                    "passed": False,
                },
                "automaticUnlocked": False,
                "override": {
                    "mode": "unlocked",
                    "changedAt": "2026-08-12T20:59:00.000Z",
                    "expiresAt": "2026-08-12T21:00:00.000Z",
                },
                "unlocked": True,
            }
        )
        current = datetime(2026, 8, 12, 20, 59, tzinfo=timezone.utc)
        reads = 0
        sleeps = 0

        async def reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                return forced_unlocked
            if reads == 2:
                return LOCKED
            raise RuntimeError("нет связи")

        async def cross_expiry_then_stop(_: float) -> None:
            nonlocal current, sleeps
            sleeps += 1
            if sleeps == 2:
                current = datetime(2026, 8, 12, 21, 1, tzinfo=timezone.utc)
            if sleeps < 3:
                return
            raise asyncio.CancelledError

        logs: list[str] = []
        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=reader,
                sleep=cross_expiry_then_stop,
                wall_clock=lambda: current,
                log=logs.append,
            )

        self.assertEqual(family.block_attempts, 2)
        self.assertEqual(family.actions, [False, True])
        self.assertTrue(family.blocked)
        self.assertIn("подтвердил требование блокировки", "\n".join(logs))

    async def test_ambiguous_unlock_is_blocked_after_expiry_during_api_outage(
        self,
    ) -> None:
        family = FailFirstUnlockFamily(blocked=True, apply_before_failure=True)
        forced_unlocked = forced_unlocked_gate()
        current = datetime(2026, 8, 12, 20, 59, tzinfo=timezone.utc)
        reads = 0
        sleeps = 0

        async def reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                return LOCKED
            if reads == 2:
                return forced_unlocked
            raise RuntimeError("нет связи")

        async def cross_expiry_then_stop(_: float) -> None:
            nonlocal current, sleeps
            sleeps += 1
            if sleeps == 2:
                current = datetime(2026, 8, 12, 21, 1, tzinfo=timezone.utc)
            if sleeps < 3:
                return
            raise asyncio.CancelledError

        logs: list[str] = []
        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=reader,
                sleep=cross_expiry_then_stop,
                wall_clock=lambda: current,
                log=logs.append,
            )

        self.assertEqual(family.actions, [True, False, True])
        self.assertTrue(family.blocked)
        self.assertIn("срок разрешённого доступа истёк", "\n".join(logs))

    async def test_initial_ambiguous_unlock_honors_valid_gate_until_expiry(
        self,
    ) -> None:
        family = FailFirstUnlockFamily(blocked=True, apply_before_failure=True)
        current = datetime(2026, 8, 12, 20, 59, tzinfo=timezone.utc)
        reads = 0
        delays: list[float] = []
        blocked_during_sleeps: list[bool] = []

        async def reader(_: str, __: str) -> GateState:
            nonlocal reads
            reads += 1
            if reads == 1:
                return forced_unlocked_gate()
            raise RuntimeError("нет связи")

        async def reach_expiry_then_stop(delay: float) -> None:
            nonlocal current
            delays.append(delay)
            blocked_during_sleeps.append(family.blocked)
            current += timedelta(seconds=delay)
            if len(delays) > 1:
                raise asyncio.CancelledError

        logs: list[str] = []
        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig(
                    "refresh",
                    "child",
                    AGENT_TOKEN,
                    EDUKATOR_URL,
                    poll_seconds=120,
                ),
                family,
                gate_reader=reader,
                sleep=reach_expiry_then_stop,
                wall_clock=lambda: current,
                log=logs.append,
            )

        self.assertEqual(delays[0], 60.0)
        self.assertEqual(blocked_during_sleeps, [False, True])
        self.assertEqual(family.actions, [False, True])
        self.assertIn("срок разрешённого доступа истёк", "\n".join(logs))

    async def test_restart_after_forced_unlock_fails_closed_across_expiry(self) -> None:
        family = FakeFamily(blocked=True)
        forced_unlocked = parse_gate(
            {
                "day": "2026-08-12",
                "required": 3,
                "completed": 0,
                "remaining": 3,
                "learning": {
                    "materialId": None,
                    "required": False,
                    "passed": False,
                },
                "automaticUnlocked": False,
                "override": {
                    "mode": "unlocked",
                    "changedAt": "2026-08-12T20:50:00.000Z",
                    "expiresAt": "2026-08-12T21:00:00.000Z",
                },
                "unlocked": True,
            }
        )
        await reconcile(
            forced_unlocked,
            family,
            ReconcileState(),
            10,
            300,
            lambda _: None,
        )
        current = datetime(2026, 8, 12, 20, 59, tzinfo=timezone.utc)
        sleeps = 0

        async def unavailable(_: str, __: str) -> GateState:
            raise RuntimeError("нет связи")

        async def cross_expiry_then_stop(_: float) -> None:
            nonlocal current, sleeps
            sleeps += 1
            if sleeps == 1:
                current = datetime(2026, 8, 12, 21, 1, tzinfo=timezone.utc)
                return
            raise asyncio.CancelledError

        logs: list[str] = []
        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child", AGENT_TOKEN, EDUKATOR_URL),
                family,
                gate_reader=unavailable,
                sleep=cross_expiry_then_stop,
                wall_clock=lambda: current,
                log=logs.append,
            )

        self.assertEqual(family.actions, [False, True])
        self.assertTrue(family.blocked)
        self.assertIn("ещё не подтвердил состояние после запуска", "\n".join(logs))

    @staticmethod
    async def _gate(gate: GateState) -> GateState:
        return gate


if __name__ == "__main__":
    unittest.main()
