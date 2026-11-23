from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger

from app.models.models import Schedule
from app.services.job_executor import utcnow


def to_utc_naive(value: datetime, timezone_name: str) -> datetime:
    zone = ZoneInfo(timezone_name)
    if value.tzinfo is None:
        localized = value.replace(tzinfo=zone)
        round_trip = localized.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)
        if round_trip != value:
            raise ValueError("Scheduled time does not exist in the selected timezone because of a daylight-saving change")
    else:
        localized = value
    return localized.astimezone(timezone.utc).replace(tzinfo=None)


def compute_next_run(schedule: Schedule, now_utc: datetime | None = None) -> datetime | None:
    now_utc = now_utc or utcnow()
    if schedule.cron_expression:
        zone = ZoneInfo(schedule.timezone or "UTC")
        trigger = CronTrigger.from_crontab(schedule.cron_expression, timezone=zone)
        local_now = now_utc.replace(tzinfo=timezone.utc).astimezone(zone)
        next_fire = trigger.get_next_fire_time(None, local_now)
        return next_fire.astimezone(timezone.utc).replace(tzinfo=None) if next_fire else None

    if schedule.scheduled_time:
        scheduled = schedule.scheduled_time
        if scheduled.tzinfo is not None:
            scheduled = scheduled.astimezone(timezone.utc).replace(tzinfo=None)
        return scheduled if scheduled > now_utc else None
    return None


def advance_next_run(schedule: Schedule, now_utc: datetime | None = None) -> datetime | None:
    now_utc = now_utc or utcnow()
    if schedule.cron_expression:
        zone = ZoneInfo(schedule.timezone or "UTC")
        trigger = CronTrigger.from_crontab(schedule.cron_expression, timezone=zone)
        local_now = now_utc.replace(tzinfo=timezone.utc).astimezone(zone)
        next_fire = trigger.get_next_fire_time(None, local_now)
        return next_fire.astimezone(timezone.utc).replace(tzinfo=None) if next_fire else None
    return None
