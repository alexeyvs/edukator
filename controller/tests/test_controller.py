from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest

from edukator_family_controller.config import (
    ControllerConfig,
    clear_pending_login,
    load_config,
    load_pending_login,
    pending_login_path,
    save_config,
    save_pending_login,
)
from edukator_family_controller.gate import GateState, parse_gate
from edukator_family_controller.family import MicrosoftFamilyClient
from edukator_family_controller.login import update_family_with_retry
from edukator_family_controller.main import ReconcileState, reconcile, run_controller


LOCKED = GateState(
    day="2026-08-12", required=3, completed=1, remaining=2, unlocked=False
)
UNLOCKED = GateState(
    day="2026-08-12", required=3, completed=3, remaining=0, unlocked=True
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


class GateContractTests(unittest.TestCase):
    def test_accepts_consistent_state(self) -> None:
        self.assertEqual(
            parse_gate(
                {
                    "day": "2026-08-12",
                    "required": 3,
                    "completed": 2,
                    "remaining": 1,
                    "unlocked": False,
                }
            ),
            GateState("2026-08-12", 3, 2, 1, False),
        )

    def test_rejects_contradictory_state(self) -> None:
        with self.assertRaisesRegex(ValueError, "противоречат"):
            parse_gate(
                {
                    "day": "2026-08-12",
                    "required": 3,
                    "completed": 2,
                    "remaining": 0,
                    "unlocked": True,
                }
            )


class ConfigTests(unittest.TestCase):
    def test_round_trip_uses_owner_only_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            expected = ControllerConfig("secret", "child-id")
            save_config(expected, path)

            self.assertEqual(load_config(path), expected)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text())["refresh_token"], "secret")

    def test_rejects_invalid_intervals(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            path.write_text(
                json.dumps(
                    {
                        "refresh_token": "secret",
                        "child_user_id": "child-id",
                        "poll_seconds": 0,
                    }
                )
            )
            with self.assertRaisesRegex(ValueError, "Интервалы"):
                load_config(path)

    def test_pending_login_is_private_and_can_be_resumed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "family.json"
            save_pending_login("resumable", path)

            self.assertEqual(load_pending_login(path), "resumable")
            self.assertEqual(os.stat(pending_login_path(path)).st_mode & 0o777, 0o600)
            clear_pending_login(path)
            self.assertIsNone(load_pending_login(path))


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

    async def test_unlocks_after_third_run_and_is_idempotent(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState()

        await reconcile(UNLOCKED, family, state, 10, 300, lambda _: None)
        await reconcile(UNLOCKED, family, state, 20, 300, lambda _: None)

        self.assertEqual(family.actions, [False])
        self.assertEqual(family.refreshes, 1)

    async def test_periodic_verification_restores_manual_unblock(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState()
        await reconcile(LOCKED, family, state, 10, 300, lambda _: None)
        family.blocked = False

        await reconcile(LOCKED, family, state, 400, 300, lambda _: None)

        self.assertEqual(family.actions, [True, True])
        self.assertEqual(family.refreshes, 2)

    async def test_renews_existing_block_once_a_day(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState()

        await reconcile(LOCKED, family, state, 10, 300, lambda _: None)
        await reconcile(LOCKED, family, state, 1000, 300, lambda _: None)
        await reconcile(LOCKED, family, state, 90_000, 300, lambda _: None)

        self.assertEqual(family.actions, [True, True])

    async def test_unavailable_edukator_never_calls_microsoft(self) -> None:
        family = FakeFamily(blocked=True)

        async def failing_reader(_: str) -> GateState:
            raise RuntimeError("нет связи")

        async def stop_after_backoff(_: float) -> None:
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child"),
                family,
                gate_reader=failing_reader,
                sleep=stop_after_backoff,
                log=lambda _: None,
            )

        self.assertEqual(family.refreshes, 0)
        self.assertEqual(family.actions, [])
        self.assertTrue(family.closed)


if __name__ == "__main__":
    unittest.main()
