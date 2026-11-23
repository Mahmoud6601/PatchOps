import re
from typing import Any, Mapping


STAGE_NAMES = ["Discovery", "Pre-check", "Update", "Reboot", "Verification"]


def map_task_to_stage(task_name: str) -> str | None:
    """Map explicit playbook stage names to matrix columns; leave unknown tasks unmapped."""
    task = re.sub(r"[^a-z0-9]+", " ", (task_name or "").lower()).strip()
    if not task:
        return None

    # Playbook lifecycle meta-tasks and workflow includes must never map to pipeline stages
    if any(task.startswith(p) for p in ("play started", "playbook started", "playbook complete", "verbose")):
        return None
    if any(task.startswith(p) for p in ("run ", "load ", "include ")) and any(t in task for t in ("workflow", "role", "playbook", "tasks")):
        return None

    # Playbooks use `Stage N: ...` labels. These take precedence over loose keywords.
    numbered = re.search(r"stage\s*([1-5])\b", task)
    if numbered:
        return STAGE_NAMES[int(numbered.group(1)) - 1]

    if any(token in task for token in ("gathering facts", "gather facts", "collect facts")):
        return "Discovery"
    if any(token in task for token in ("pre check", "precheck", "preflight")):
        return "Pre-check"
    if any(token in task for token in ("verification", "verify", "post reboot")):
        return "Verification"
    if "reboot" in task:
        return "Reboot"
    if any(token in task for token in ("apply update", "install update", "install patch", "apply patch", "apt get upgrade", "yum update", "dnf upgrade", "windows update")):
        return "Update"
    return None


def status_for_awx_event(event_type: str) -> str | None:
    return {
        "runner_on_start": "running",
        "runner_on_ok": "success",
        "runner_item_on_ok": "success",
        "runner_on_failed": "failed",
        "runner_item_on_failed": "failed",
        "runner_on_unreachable": "unreachable",
        "runner_on_skipped": "skipped",
        "runner_item_on_skipped": "skipped",
    }.get(event_type)


def event_applies_to_os(event_data: Mapping[str, Any], os_family: str) -> bool:
    """Return whether an AWX host event belongs to the host's OS workflow.

    AWX emits a ``skipped`` event for every statically-declared task whose
    condition evaluates to false.  Without this guard, a Windows host receives
    the skipped Linux patch tasks (and vice versa), which makes future stages
    appear to have started before their real predecessor is complete.
    """
    source = " ".join(
        str(event_data.get(field) or "")
        for field in ("task", "role", "task_path", "resolved_action")
    ).casefold()

    windows_markers = (
        "windows_patching",
        "ansible.windows",
        "win_updates",
        "win_reboot",
        "win_service",
        "win_powershell",
        "win_reg",
        "windows update",
        "windows reboot",
        "windows patch",
        "windows system metadata",
    )
    linux_markers = (
        "linux_patching",
        "ansible.builtin.apt",
        "ansible.builtin.dnf",
        "community.general.zypper",
        "apt metadata",
        "apt security",
        "debian",
        "rhel",
        "suse",
        "linux family",
        "linux update",
        "linux system metadata",
    )
    is_windows_event = any(marker in source for marker in windows_markers)
    is_linux_event = any(marker in source for marker in linux_markers)

    normalized_os = str(os_family or "").casefold()
    if normalized_os == "windows":
        return not is_linux_event
    if normalized_os == "linux":
        return not is_windows_event
    return True
