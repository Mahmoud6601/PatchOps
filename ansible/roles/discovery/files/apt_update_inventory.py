#!/usr/bin/python3
"""Report upgradable APT packages whose candidate comes from a security archive."""

import json

import apt

cache = apt.Cache()
pending = []
security = []
for package in cache:
    if not package.is_upgradable or package.candidate is None:
        continue
    pending.append(package.name)
    for origin in package.candidate.origins:
        archive = (origin.archive or "").lower()
        label = (origin.label or "").lower()
        if "security" in archive or "security" in label:
            security.append(package.name)
            break

print(json.dumps({
    "pending_count": len(pending),
    "security_count": len(security),
    "pending_packages": sorted(set(pending)),
    "security_packages": sorted(set(security)),
}))
