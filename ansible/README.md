# Enterprise OS Patching & Update Management Platform Playbooks

This repository contains version-controlled Ansible playbooks and roles for orchestrating OS patch management across enterprise Linux and Windows infrastructure.

## Pipelines
- `playbooks/discovery.yml`: Automated discovery of OS facts, hardware resources, reboot pending flags, and package managers.
- `playbooks/patch_security.yml`: Targeted installation of security-classified updates.
- `playbooks/patch_regular.yml`: Installation of regular approved updates and package rollups.
- `playbooks/upgrade_major_os.yml`: Strictly gated major OS version upgrades requiring dual confirmation (`confirm_major_upgrade=true`, `backup_verified=true`).

## Supported Operating Systems
- **Linux:** Ubuntu, Debian, RHEL, Rocky Linux, AlmaLinux, SUSE Enterprise Linux.
- **Windows:** Windows Server 2016, 2019, 2022, 2025; Windows 10, Windows 11.
