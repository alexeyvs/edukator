from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
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
from edukator_family_controller.gate import (
    ComputerAccessOverride,
    GateState,
    LearningGateState,
    parse_gate,
)
from edukator_family_controller.family import MicrosoftFamilyClient
from edukator_family_controller.login import update_family_with_retry
from edukator_family_controller.main import ReconcileState, reconcile, run_controller


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
        self.assertIsNone(state.access_expires_at)

    async def test_unlocks_after_third_run_and_is_idempotent(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState()

        await reconcile(UNLOCKED, family, state, 10, 300, lambda _: None)
        await reconcile(UNLOCKED, family, state, 20, 300, lambda _: None)

        self.assertEqual(family.actions, [False])
        self.assertEqual(family.refreshes, 1)

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

    async def test_renews_existing_block_once_a_day(self) -> None:
        family = FakeFamily(blocked=True)
        state = ReconcileState()

        await reconcile(LOCKED, family, state, 10, 300, lambda _: None)
        await reconcile(LOCKED, family, state, 1000, 300, lambda _: None)
        await reconcile(LOCKED, family, state, 90_000, 300, lambda _: None)

        self.assertEqual(family.actions, [True, True])

    async def test_unavailable_edukator_on_startup_verifies_safe_block(self) -> None:
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

        self.assertEqual(family.refreshes, 1)
        self.assertEqual(family.actions, [])
        self.assertTrue(family.closed)

    async def test_invalid_first_gate_still_fails_closed_on_startup(self) -> None:
        family = FakeFamily(blocked=False)
        logs: list[str] = []

        async def invalid_reader(_: str) -> GateState:
            raise ValueError("invalid gate payload")

        async def stop_after_backoff(_: float) -> None:
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await run_controller(
                ControllerConfig("refresh", "child"),
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
                ControllerConfig("refresh", "child"),
                family,
                gate_reader=lambda _: self._gate(LOCKED),
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

        async def reader(_: str) -> GateState:
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
                ControllerConfig("refresh", "child"),
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

        async def reader(_: str) -> GateState:
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
                ControllerConfig("refresh", "child"),
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
                ControllerConfig("refresh", "child"),
                family,
                gate_reader=lambda _: self._gate(UNLOCKED),
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

        async def recovering_reader(_: str) -> GateState:
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
                ControllerConfig("refresh", "child"),
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

        async def reader(_: str) -> GateState:
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
                ControllerConfig("refresh", "child"),
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

                async def reader(_: str) -> GateState:
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
                        ControllerConfig("refresh", "child"),
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

        async def reader(_: str) -> GateState:
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
                ControllerConfig("refresh", "child"),
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

                async def reader(_: str) -> GateState:
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
                        ControllerConfig("refresh", "child"),
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

        async def reader(_: str) -> GateState:
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
                ControllerConfig("refresh", "child"),
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

        async def reader(_: str) -> GateState:
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
                ControllerConfig("refresh", "child"),
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

        async def reader(_: str) -> GateState:
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
                ControllerConfig("refresh", "child"),
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

        async def reader(_: str) -> GateState:
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

        async def unavailable(_: str) -> GateState:
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
                ControllerConfig("refresh", "child"),
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
