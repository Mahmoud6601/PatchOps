import React, { useEffect, useState, useMemo } from 'react';
import {
  Server as ServerIcon,
  Plus,
  Trash2,
  RefreshCw,
  ShieldCheck,
  Search,
  CheckCircle2,
  X,
  Pencil,
  RotateCcw,
  Building2,
  MoreVertical,
  AlertTriangle,
  HardDrive,
  Cpu,
  Layers,
  Calendar,
  Check,
  Filter,
  CheckSquare,
  Square,
  ShieldAlert,
  ArrowRight,
  Power,
  Wrench,
  ExternalLink,
  Terminal,
  Copy,
  BookOpen,
  Download,
  Lock,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { AwxMachineCredential, InstalledPatch, Server, ServerGroup, User } from '../types';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { ConfirmModal } from '../components/ConfirmModal';
import { formatUtcDate, formatDuration } from '../date';

interface ServersPageProps {
  onNavigateToBuild: (buildId: string) => void;
  currentUser: User | null;
}

const FILTERS_STORAGE_KEY = 'patching_servers_filters';

const WINRM_SETUP_SCRIPT = `Set-Service -Name WinRM -StartupType Automatic; Start-Service -Name WinRM; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $cert = New-SelfSignedCertificate -DnsName $env:COMPUTERNAME, "localhost" -CertStoreLocation Cert:\\LocalMachine\\My; winrm delete winrm/config/Listener?Address=*+Transport=HTTPS 2>$null; winrm create winrm/config/Listener?Address=*+Transport=HTTPS "@{Hostname=\`"$env:COMPUTERNAME\`";CertificateThumbprint=\`"$($cert.Thumbprint)\`"}"; netsh advfirewall firewall add rule name="WinRM HTTPS" dir=in action=allow protocol=TCP localport=5986 2>$null; Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name 'LocalAccountTokenFilterPolicy' -Value 1 -Type DWord; winrm set winrm/config/service/auth '@{Basic="true"}'; Restart-Service WinRM`;

const LINUX_SETUP_SCRIPT = `sudo apt-get update && sudo apt-get install -y openssh-server python3 sudo || sudo yum install -y openssh-server python3 sudo; sudo systemctl enable --now ssh || sudo systemctl enable --now sshd`;

interface SavedFilters {
  search?: string;
  customerFilter?: string;
  osFilter?: string;
  statusFilter?: string;
  rebootFilter?: string;
  updatesFilter?: string;
  includeRetired?: boolean;
}

const getSavedFilters = (): SavedFilters => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = sessionStorage.getItem(FILTERS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

export const ServersPage: React.FC<ServersPageProps> = ({ onNavigateToBuild, currentUser }) => {
  const canOperate = currentUser?.role === 'administrator' || currentUser?.role === 'operator';
  const { success, error: toastError, info } = useToast();
  // Confirm modal state
  const [confirmModal, setConfirmModal] = React.useState<{
    open: boolean; title: string; message: string;
    confirmLabel: string; variant: 'danger' | 'warning' | 'info';
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', confirmLabel: 'Confirm', variant: 'danger', onConfirm: () => {} });
  const closeConfirm = () => setConfirmModal((p) => ({ ...p, open: false }));
  const showConfirm = (title: string, message: string, confirmLabel: string,
    variant: 'danger' | 'warning' | 'info', onConfirm: () => void) => {
    setConfirmModal({ open: true, title, message, confirmLabel, variant, onConfirm });
  };

  const isAdmin = currentUser?.role === 'administrator';

  // State
  const [servers, setServers] = useState<Server[]>([]);
  const [groups, setGroups] = useState<ServerGroup[]>([]);
  const [awxCredentials, setAwxCredentials] = useState<AwxMachineCredential[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [allowOverlap, setAllowOverlap] = useState(false);
  const [selectedServer, setSelectedServer] = useState<Server | null>(null);

  const savedFilters = getSavedFilters();
  const [searchParams] = useSearchParams();
  const urlGroupParam = searchParams.get('group');

  // Filters (Action1 signature inline filters with sessionStorage + URL query persistence)
  const [search, setSearch] = useState<string>(() => savedFilters.search || '');
  const [customerFilter, setCustomerFilter] = useState<string>(
    () => urlGroupParam ?? savedFilters.customerFilter ?? ''
  );
  const [osFilter, setOsFilter] = useState<string>(() => savedFilters.osFilter || '');
  const [statusFilter, setStatusFilter] = useState<string>(() => savedFilters.statusFilter || '');
  const [rebootFilter, setRebootFilter] = useState<string>(() => savedFilters.rebootFilter || '');
  const [updatesFilter, setUpdatesFilter] = useState<string>(() => savedFilters.updatesFilter || '');
  const [includeRetired, setIncludeRetired] = useState<boolean>(() => savedFilters.includeRetired ?? false);

  // Sync active filters to sessionStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
        search,
        customerFilter,
        osFilter,
        statusFilter,
        rebootFilter,
        updatesFilter,
        includeRetired,
      }));
    }
  }, [search, customerFilter, osFilter, statusFilter, rebootFilter, updatesFilter, includeRetired]);

  // Active row dropdown for 3-dots action menu
  const [actionModalServer, setActionModalServer] = useState<Server | null>(null);

  // Customer Management Modal
  const [isAddCustomerOpen, setIsAddCustomerOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<ServerGroup | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerDesc, setNewCustomerDesc] = useState('');
  const [newCustomerLinuxCred, setNewCustomerLinuxCred] = useState<string>('');
  const [newCustomerWinCred, setNewCustomerWinCred] = useState<string>('');
  const [customerSubmitting, setCustomerSubmitting] = useState(false);

  // Add / Edit Server Modal
  const [isAddServerOpen, setIsAddServerOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<Server | null>(null);
  const [newHostname, setNewHostname] = useState('');
  const [newIp, setNewIp] = useState('');
  const [newOsFamily, setNewOsFamily] = useState<'linux' | 'windows'>('linux');
  const [newAwxCredentialId, setNewAwxCredentialId] = useState('');
  const [newWinrmCertValidation, setNewWinrmCertValidation] = useState<'' | 'validate' | 'ignore'>('');
  const [newGroupId, setNewGroupId] = useState('');
  const [showAllCredentials, setShowAllCredentials] = useState(false);
  const [refreshingCreds, setRefreshingCreds] = useState(false);

  // Target Node Onboarding & Setup Guide
  const [isSetupGuideOpen, setIsSetupGuideOpen] = useState(false);
  const [setupGuideOs, setSetupGuideOs] = useState<'windows' | 'linux'>('windows');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Installed Patch History (Telemetry 360° Modal)
  const [installedPatches, setInstalledPatches] = useState<InstalledPatch[]>([]);
  const [patchesLoading, setPatchesLoading] = useState(false);
  const [patchSearch, setPatchSearch] = useState('');

  // Admin-Gated Major OS Upgrade Modal
  const [majorUpgradeServer, setMajorUpgradeServer] = useState<Server | null>(null);
  const [confirmMajorUpgrade, setConfirmMajorUpgrade] = useState(false);
  const [confirmBackupVerified, setConfirmBackupVerified] = useState(false);
  const [majorUpgradeSubmitting, setMajorUpgradeSubmitting] = useState(false);

  useEffect(() => {
    if (!selectedServer) {
      setInstalledPatches([]);
      setPatchSearch('');
      return;
    }
    let cancelled = false;
    setPatchesLoading(true);
    api.getServerPatches(selectedServer.id, undefined, 150)
      .then((rows) => {
        if (!cancelled) setInstalledPatches(rows);
      })
      .catch(() => {
        if (!cancelled) setInstalledPatches([]);
      })
      .finally(() => {
        if (!cancelled) setPatchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedServer?.id]);

  const copyToClipboard = async (text: string, key = 'copied') => {
    let succeeded = false;
    // 1. Try modern clipboard API if in a secure context (HTTPS / localhost)
    if (navigator?.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        succeeded = true;
      } catch (err) {
        console.warn('Modern clipboard write failed, trying fallback:', err);
      }
    }

    // 2. Reliable fallback using hidden textarea + execCommand('copy') for HTTP/IP access
    if (!succeeded) {
      try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.width = '2em';
        textArea.style.height = '2em';
        textArea.style.padding = '0';
        textArea.style.border = 'none';
        textArea.style.outline = 'none';
        textArea.style.boxShadow = 'none';
        textArea.style.background = 'transparent';
        textArea.setAttribute('readonly', '');
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        succeeded = document.execCommand('copy');
        document.body.removeChild(textArea);
      } catch (err) {
        console.error('Fallback execCommand copy failed:', err);
      }
    }

    // 3. Trigger lively visual confirmation
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 2500);
  };

  // Bulk Assign Customer Dropdown in Toolbar
  const [isBulkCustomerOpen, setIsBulkCustomerOpen] = useState(false);
  const [bulkApplyDefaults, setBulkApplyDefaults] = useState(true);

  // Helper for Credential Auto-inheritance
  const autoInheritCredential = (groupIdStr: string, osFamily: 'linux' | 'windows') => {
    if (!groupIdStr) return;
    const grp = groups.find((g) => String(g.id) === String(groupIdStr));
    if (!grp) return;
    if (osFamily === 'linux' && grp.default_linux_credential_id) {
      setNewAwxCredentialId(String(grp.default_linux_credential_id));
    } else if (osFamily === 'windows' && grp.default_windows_credential_id) {
      setNewAwxCredentialId(String(grp.default_windows_credential_id));
    }
  };

  const refreshCredentials = async () => {
    try {
      setRefreshingCreds(true);
      const creds = await api.getAwxMachineCredentials();
      setAwxCredentials(creds);
    } catch (err) {
      console.error('Failed to refresh AWX credentials', err);
    } finally {
      setRefreshingCreds(false);
    }
  };

  const loadData = async (showSpinner = true) => {
    try {
      if (showSpinner) setLoading(true);
      const [sData, gData, credentialData] = await Promise.all([
        api.getServers(
          search || undefined,
          osFilter || undefined,
          customerFilter ? Number(customerFilter) : undefined,
          includeRetired
        ),
        api.getServerGroups(),
        api.getAwxMachineCredentials(),
      ]);
      setServers(sData);
      setGroups(gData);
      setAwxCredentials(credentialData);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData(true);
  }, [search, osFilter, customerFilter, includeRetired]);

  // Real-time SSE fleet updates when discovery/patch runs complete
  useEffect(() => {
    let initialFrame = true;
    const unsubscribe = api.subscribeSse('/stream/fleet', (eventName) => {
      if (eventName === 'fleet_update') {
        if (initialFrame) {
          initialFrame = false;
          return;
        }
        loadData(false);
      }
    });
    return () => unsubscribe();
  }, [search, osFilter, customerFilter, includeRetired]);

  // Close menus when clicking outside
  useEffect(() => {
    const handleOutsideClick = () => {
      setActionModalServer(null);
      setIsBulkCustomerOpen(false);
    };
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  // Filtered servers (client-side enhancements for status, reboot, updates)
  const filteredServers = useMemo(() => {
    return servers.filter((s) => {
      if (statusFilter && s.connection_status !== statusFilter) return false;
      if (rebootFilter === 'required' && !s.reboot_required) return false;
      if (rebootFilter === 'clean' && s.reboot_required) return false;
      if (updatesFilter === 'updates_pending' && s.pending_updates_count === 0) return false;
      if (updatesFilter === 'up_to_date' && (s.pending_updates_count > 0 || !s.discovery_fresh)) return false;
      return true;
    });
  }, [servers, statusFilter, rebootFilter, updatesFilter]);

  const hasActiveFilters = Boolean(
    search || customerFilter || osFilter || statusFilter || rebootFilter || updatesFilter || includeRetired
  );

  const resetFilters = () => {
    setSearch('');
    setCustomerFilter('');
    setOsFilter('');
    setStatusFilter('');
    setRebootFilter('');
    setUpdatesFilter('');
    setIncludeRetired(false);
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(FILTERS_STORAGE_KEY);
    }
  };

  // Selection handlers
  const toggleSelectAll = () => {
    const activeManageableIds = filteredServers.filter((s) => s.is_managed).map((s) => s.id);
    const allSelected = activeManageableIds.length > 0 && activeManageableIds.every((id) => selectedIds.includes(id));
    if (allSelected) {
      setSelectedIds(selectedIds.filter((id) => !activeManageableIds.includes(id)));
    } else {
      setSelectedIds(Array.from(new Set([...selectedIds, ...activeManageableIds])));
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  // Batch Launch
  const handleBatchLaunch = async (type: 'security' | 'regular' | 'discovery', targets = selectedIds) => {
    if (targets.length === 0) return;
    try {
      setActionLoading(true);
      const job = await api.launchJob({
        job_name: `${type === 'discovery' ? 'Discovery' : type === 'security' ? 'Security Patching' : 'Regular Updates'} (${targets.length} hosts)`,
        update_type: type,
        server_ids: targets,
        allow_overlap: isAdmin && allowOverlap,
      });

      if (job.batch_count && job.batch_count > 1 && job.batch_build_ids) {
        info('Batch Jobs Launched', `${job.batch_count} parallel jobs — Windows and Linux run in separate batches (different AWX credentials). Each gets its own Run ID.`);
      }
      onNavigateToBuild(job.build_id);
    } catch (e: any) {
      toastError('Launch Failed', e.message || 'Error executing job');
    } finally {
      setActionLoading(false);
      setAllowOverlap(false);
    }
  };


  // Phase 2 Handlers: Direct Action Reboot & Windows Update Cache Reset
  const handleRebootServer = async (id: number, hostname: string) => {
    showConfirm('Reboot Server', `Initiate controlled reboot for ${hostname}?`, 'Reboot', 'warning', async () => {
      closeConfirm();
      try {
        setActionLoading(true);
        const res = await api.rebootServer(id, false, isAdmin && allowOverlap);
        success('Reboot Queued', `${hostname} → ${res.build_id}`);
        onNavigateToBuild(res.build_id);
      } catch (err: any) {
        toastError('Action Failed', err.message || 'Failed to trigger reboot');
      } finally {
        setActionLoading(false);
        setAllowOverlap(false);
      }
    });
  };

  const handleClearRebootFlag = async (id: number, hostname: string) => {
    showConfirm('Clear Reboot Flag', `Mark pending reboot as resolved for ${hostname}?`, 'Clear Flag', 'info', async () => {
      closeConfirm();
      try {
        setActionLoading(true);
        await api.rebootServer(id, true);
        success('Reboot Flag Cleared', hostname);
        await loadData();
        if (selectedServer?.id === id) {
          setSelectedServer((prev) => prev ? { ...prev, reboot_required: false } : null);
        }
      } catch (err: any) {
        toastError('Action Failed', err.message || 'Failed to clear reboot flag');
      } finally {
        setActionLoading(false);
      }
    });
  };

  const handleResetCache = async (id: number, hostname: string) => {
    showConfirm('Reset Windows Update Cache', `Clean and reset Windows Update cache on ${hostname}? This will purge corrupted SoftwareDistribution files and restart update services.`, 'Reset Cache', 'warning', async () => {
      closeConfirm();
      try {
        setActionLoading(true);
        const res = await api.resetWindowsCache(id, isAdmin && allowOverlap);
        success('Cache Reset Queued', `${hostname} → ${res.build_id}`);
        onNavigateToBuild(res.build_id);
      } catch (err: any) {
        toastError('Action Failed', err.message || 'Failed to trigger cache reset');
      } finally {
        setActionLoading(false);
        setAllowOverlap(false);
      }
    });
  };

  const handleBulkReboot = async () => {
    showConfirm('Bulk Reboot', `Initiate controlled reboot for ${selectedIds.length} selected server(s)?`, 'Reboot All', 'warning', async () => {
      closeConfirm();
      try {
        setActionLoading(true);
        const res = await api.bulkReboot(selectedIds, false, isAdmin && allowOverlap);
        success('Bulk Reboot Queued', `${res.build_id} — ${selectedIds.length} hosts`);
        setSelectedIds([]);
        onNavigateToBuild(res.build_id);
      } catch (err: any) {
        toastError('Action Failed', err.message || 'Failed to trigger bulk reboot');
      } finally {
        setActionLoading(false);
        setAllowOverlap(false);
      }
    });
  };

  const handleBulkResetCache = async () => {
    const winCount = servers.filter((s) => selectedIds.includes(s.id) && s.os_family === 'windows').length;
    if (winCount === 0) {
      toastError('No Windows Servers', 'None of the selected servers are Windows.');
      return;
    }
    showConfirm('Bulk Reset Windows Cache', `Clean and reset Windows Update cache on ${winCount} selected Windows server(s)?`, 'Reset Cache', 'warning', async () => {
      closeConfirm();
      try {
        setActionLoading(true);
        const res = await api.bulkResetWindowsCache(selectedIds, isAdmin && allowOverlap);
        success('Bulk Cache Reset Queued', `${winCount} Windows hosts — ${res.build_id}`);
        setSelectedIds([]);
        onNavigateToBuild(res.build_id);
      } catch (err: any) {
        toastError('Action Failed', err.message || 'Failed to trigger bulk cache reset');
      } finally {
        setActionLoading(false);
        setAllowOverlap(false);
      }
    });
  };

  const handleLaunchMajorUpgrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!majorUpgradeServer || !confirmMajorUpgrade || !confirmBackupVerified) return;
    try {
      setMajorUpgradeSubmitting(true);
      const job = await api.launchJob({
        job_name: `Major OS Upgrade • ${majorUpgradeServer.hostname}`,
        update_type: 'major_upgrade',
        server_ids: [majorUpgradeServer.id],
        confirm_major_upgrade: true,
        backup_verified: true,
        allow_overlap: isAdmin && allowOverlap,
      });
      success('Major OS Upgrade Queued', `${majorUpgradeServer.hostname} → ${job.build_id}`);
      setMajorUpgradeServer(null);
      setConfirmMajorUpgrade(false);
      setConfirmBackupVerified(false);
      onNavigateToBuild(job.build_id);
    } catch (err: any) {
      toastError('Upgrade Blocked', err.message || 'Failed to launch major OS upgrade');
    } finally {
      setMajorUpgradeSubmitting(false);
      setAllowOverlap(false);
    }
  };

  // Single Server Launch
  const handleSingleServerLaunch = (type: 'security' | 'regular' | 'discovery', server: Server) => {
    handleBatchLaunch(type, [server.id]);
  };

  // Open Customer Modal (Create or Edit)
  const openAddCustomer = () => {
    setEditingCustomer(null);
    setNewCustomerName('');
    setNewCustomerDesc('');
    setNewCustomerLinuxCred('');
    setNewCustomerWinCred('');
    setIsAddCustomerOpen(true);
  };

  const openEditCustomer = (group: ServerGroup) => {
    setEditingCustomer(group);
    setNewCustomerName(group.name);
    setNewCustomerDesc(group.description || '');
    setNewCustomerLinuxCred(group.default_linux_credential_id ? String(group.default_linux_credential_id) : '');
    setNewCustomerWinCred(group.default_windows_credential_id ? String(group.default_windows_credential_id) : '');
    setIsAddCustomerOpen(true);
  };

  // Create or Update Customer / Group with Default Credentials
  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustomerName.trim()) return;
    try {
      setCustomerSubmitting(true);
      const payload = {
        name: newCustomerName.trim(),
        description: newCustomerDesc.trim() || undefined,
        default_linux_credential_id: newCustomerLinuxCred ? parseInt(newCustomerLinuxCred, 10) : null,
        default_windows_credential_id: newCustomerWinCred ? parseInt(newCustomerWinCred, 10) : null,
      };

      if (editingCustomer) {
        await api.updateServerGroup(editingCustomer.id, payload);
        success('Customer Updated', newCustomerName);
      } else {
        await api.createServerGroup(payload);
        success('Customer Created', newCustomerName);
      }

      setNewCustomerName('');
      setNewCustomerDesc('');
      setNewCustomerLinuxCred('');
      setNewCustomerWinCred('');
      setEditingCustomer(null);
      setIsAddCustomerOpen(false);
      const updatedGroups = await api.getServerGroups();
      setGroups(updatedGroups);
    } catch (err: any) {
      toastError('Action Failed', err.message || 'Error saving customer');
    } finally {
      setCustomerSubmitting(false);
    }
  };

  // Bulk Assign Customer with Optional Default Credential Inheritance
  const handleBulkAssignCustomer = async (groupId: number | null) => {
    if (selectedIds.length === 0) return;
    try {
      setActionLoading(true);
      await api.bulkAssignGroup(selectedIds, groupId, bulkApplyDefaults);
      setIsBulkCustomerOpen(false);
      setSelectedIds([]);
      await loadData();
      success('Servers Assigned', 'Customer assignment updated.');
    } catch (err: any) {
      toastError('Action Failed', err.message || 'Error assigning customer');
    } finally {
      setActionLoading(false);
    }
  };

  // Save Server (Add / Edit)
  const handleSaveServer = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const values = {
        hostname: newHostname.trim(),
        ip_address: newIp.trim(),
        os_family: newOsFamily,
        awx_credential_id: newAwxCredentialId ? Number(newAwxCredentialId) : null,
        winrm_cert_validation:
          newOsFamily === 'windows' ? (newWinrmCertValidation || null) : null,
        group_id: newGroupId ? Number(newGroupId) : null,
      };
      if (editingServer) {
        await api.updateServer(editingServer.id, values);
      } else {
        await api.createServer(values);
      }
      setIsAddServerOpen(false);
      setEditingServer(null);
      setNewHostname('');
      setNewIp('');
      setNewAwxCredentialId('');
      setNewWinrmCertValidation('');
      setNewGroupId('');
      loadData();
    } catch (err: any) {
      toastError('Action Failed', err.message || 'Error saving server');
    }
  };

  const openAddServer = () => {
    setEditingServer(null);
    setNewHostname('');
    setNewIp('');
    setNewOsFamily('linux');
    setNewAwxCredentialId('');
    setNewWinrmCertValidation('');
    setNewGroupId(customerFilter || '');
    setIsAddServerOpen(true);
    refreshCredentials();
  };

  const openEditServer = (server: Server) => {
    setEditingServer(server);
    setNewHostname(server.hostname);
    setNewIp(server.ip_address);
    setNewOsFamily(server.os_family);
    setNewAwxCredentialId(server.awx_credential_id ? String(server.awx_credential_id) : '');
    setNewWinrmCertValidation(server.winrm_cert_validation || '');
    setNewGroupId(server.group_id ? String(server.group_id) : '');
    setIsAddServerOpen(true);
    refreshCredentials();
  };

  const handleDeleteServer = (id: number, hostname: string) => {
    showConfirm('Retire Server', `Retire ${hostname} from managed inventory? Its execution history will be retained.`, 'Retire', 'danger', async () => {
      closeConfirm();
      try {
        await api.deleteServer(id);
        setSelectedIds((current) => current.filter((serverId) => serverId !== id));
        loadData();
        if (selectedServer?.id === id) setSelectedServer(null);
      } catch (err: any) {
        toastError('Action Failed', err.message || 'Error deleting server');
      }
    });
  };

  const handleRestoreServer = (server: Server) => {
    showConfirm('Restore Server', `Restore ${server.hostname} to managed inventory? Discovery will be required before patching.`, 'Restore', 'info', async () => {
      closeConfirm();
      try {
        await api.restoreServer(server.id);
        await loadData();
      } catch (error: any) {
        toastError('Action Failed', error.message || 'Could not restore server');
      }
    });
  };

  const handleSyncAwx = async () => {
    try {
      setActionLoading(true);
      const result = await api.syncAwxInventory();
      success('AWX Sync Complete', `Synchronized ${result.synchronized_hosts} host(s) with inventory ${result.inventory_id}.`);
    } catch (error: any) {
      toastError('Action Failed', error.message || 'AWX inventory synchronization failed');
    } finally {
      setActionLoading(false);
    }
  };

  const getCustomerName = (groupId?: number | null) => {
    if (!groupId) return 'Unassigned';
    return groups.find((g) => g.id === groupId)?.name || `Customer #${groupId}`;
  };

  const getCredentialName = (credentialId?: number | null) =>
    awxCredentials.find((c) => c.id === credentialId)?.name || 'Select Credential';

  return (
    <div className="space-y-4">
      <ConfirmModal
        isOpen={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmLabel={confirmModal.confirmLabel}
        variant={confirmModal.variant}
        onConfirm={confirmModal.onConfirm}
        onCancel={closeConfirm}
      />
      {/* Top Header & Management Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
        <div>
          <div className="flex items-center space-x-2">
            <h2 className="text-lg font-bold text-slate-900 tracking-tight">Managed Endpoints & Inventory</h2>
            <span className="px-2 py-0.5 text-[11px] font-semibold font-mono rounded-full bg-slate-100 text-slate-600 border border-slate-200">
              {filteredServers.length} {filteredServers.length === 1 ? 'Server' : 'Servers'}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Organize servers by customer, schedule updates, and execute parallel AWX pipelines.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Customer Management Menu */}
          {canOperate && (
            <div className="flex items-center space-x-1">
              <button
                onClick={openAddCustomer}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 font-medium text-xs shadow-xs transition-colors"
                title="Add a new customer organization"
              >
                <Building2 className="w-3.5 h-3.5 text-indigo-600" />
                <span>+ Add Customer</span>
              </button>

              {groups.length > 0 && customerFilter !== 'all' && (
                (() => {
                  const currentGrp = groups.find((g) => String(g.id) === customerFilter);
                  if (!currentGrp) return null;
                  return (
                    <button
                      onClick={() => openEditCustomer(currentGrp)}
                      className="px-2.5 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-medium text-xs shadow-xs transition-colors"
                      title="Edit Customer Defaults & SLA"
                    >
                      <span>Edit {currentGrp.name}</span>
                    </button>
                  );
                })()
              )}
            </div>
          )}

          {/* Target Setup Guide */}
          <button
            onClick={() => {
              setSetupGuideOs('windows');
              setIsSetupGuideOpen(true);
            }}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-medium text-xs shadow-xs transition-colors"
            title="Target Node Setup Guide (WinRM HTTPS & SSH)"
          >
            <Terminal className="w-3.5 h-3.5 text-indigo-600" />
            <span>Target Setup Guide</span>
          </button>

          {/* Add Server Button */}
          {canOperate && (
            <button
              onClick={openAddServer}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-xs transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Server</span>
            </button>
          )}

          {/* Sync AWX Inventory */}
          {isAdmin && (
            <button
              onClick={handleSyncAwx}
              disabled={actionLoading}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 font-medium text-xs shadow-xs disabled:opacity-50 transition-colors"
              title="Synchronize hosts with AWX inventory"
            >
              <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
              <span>Sync AWX</span>
            </button>
          )}

          {/* Refresh Data */}
          <button
            onClick={() => {
              loadData();
              refreshCredentials();
            }}
            disabled={loading || actionLoading}
            className="p-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-600 border border-slate-300 shadow-xs transition-colors"
            title="Refresh inventory"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${loading || refreshingCreds ? 'animate-spin text-blue-600' : ''}`} />
          </button>
        </div>
      </div>

      {/* Action1 Signature: Multi-Filter Inline Toolbar */}
      <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-xs flex flex-wrap items-center gap-2 text-xs">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
          <input
            type="text"
            placeholder="Search hostname or IP..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-50/50 border border-slate-300 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:bg-white transition-all"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-2 text-slate-400 hover:text-slate-600"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Customer Filter */}
        <div className="flex items-center space-x-1 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200">
          <Building2 className="w-3 h-3 text-indigo-500" />
          <select
            value={customerFilter}
            onChange={(e) => setCustomerFilter(e.target.value)}
            className="bg-transparent text-xs text-slate-700 font-medium focus:outline-none cursor-pointer"
          >
            <option value="">Customer: All</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>

        {/* OS Filter */}
        <div className="flex items-center space-x-1 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200">
          <Layers className="w-3 h-3 text-blue-500" />
          <select
            value={osFilter}
            onChange={(e) => setOsFilter(e.target.value)}
            className="bg-transparent text-xs text-slate-700 font-medium focus:outline-none cursor-pointer"
          >
            <option value="">OS: All</option>
            <option value="windows">Windows</option>
            <option value="linux">Linux</option>
          </select>
        </div>

        {/* Status Filter */}
        <div className="flex items-center space-x-1 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200">
          <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-transparent text-xs text-slate-700 font-medium focus:outline-none cursor-pointer"
          >
            <option value="">Status: All</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="unreachable">Unreachable</option>
          </select>
        </div>

        {/* Reboot Filter */}
        <div className="flex items-center space-x-1 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200">
          <AlertTriangle className="w-3 h-3 text-amber-500" />
          <select
            value={rebootFilter}
            onChange={(e) => setRebootFilter(e.target.value)}
            className="bg-transparent text-xs text-slate-700 font-medium focus:outline-none cursor-pointer"
          >
            <option value="">Reboot: All</option>
            <option value="required">Reboot Required</option>
            <option value="clean">Clean</option>
          </select>
        </div>

        {/* Updates Filter */}
        <div className="flex items-center space-x-1 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200">
          <ShieldAlert className="w-3 h-3 text-rose-500" />
          <select
            value={updatesFilter}
            onChange={(e) => setUpdatesFilter(e.target.value)}
            className="bg-transparent text-xs text-slate-700 font-medium focus:outline-none cursor-pointer"
          >
            <option value="">Updates: All</option>
            <option value="updates_pending">Updates Available</option>
            <option value="up_to_date">Up-to-date</option>
          </select>
        </div>

        {/* Show Retired Checkbox */}
        {isAdmin && (
          <label className="flex items-center space-x-1.5 text-xs text-slate-600 cursor-pointer pl-1">
            <input
              type="checkbox"
              checked={includeRetired}
              onChange={(e) => setIncludeRetired(e.target.checked)}
              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span>Retired</span>
          </label>
        )}

        {/* Reset Filters */}
        {hasActiveFilters && (
          <button
            onClick={resetFilters}
            className="flex items-center space-x-1 text-xs text-rose-600 hover:text-rose-700 font-medium px-2 py-1 rounded hover:bg-rose-50 transition-colors ml-auto"
          >
            <X className="w-3 h-3" />
            <span>Reset</span>
          </button>
        )}
      </div>

      {/* Action1 Signature: Contextual Bulk Action Bar (Active when items selected) */}
      {selectedIds.length > 0 && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 p-3 rounded-xl shadow-xs flex flex-wrap items-center justify-between gap-3 animate-in fade-in duration-200">
          <div className="flex items-center space-x-3">
            <span className="px-2.5 py-1 rounded-full bg-blue-600 text-white font-bold text-xs shadow-xs">
              {selectedIds.length} Endpoints Selected
            </span>
            {isAdmin && (
              <label className="flex items-center space-x-1.5 text-xs text-amber-900 font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowOverlap}
                  onChange={(e) => setAllowOverlap(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span>Approve Overlap</span>
              </label>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canOperate && (
              <>
                <button
                  onClick={() => handleBatchLaunch('security')}
                  disabled={actionLoading}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium text-xs shadow-xs transition-colors disabled:opacity-50"
                >
                  <ShieldAlert className="w-3.5 h-3.5" />
                  <span>Patch Security</span>
                </button>

                <button
                  onClick={() => handleBatchLaunch('regular')}
                  disabled={actionLoading}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-xs transition-colors disabled:opacity-50"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Patch Regular</span>
                </button>

                <button
                  onClick={() => handleBatchLaunch('discovery')}
                  disabled={actionLoading}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 font-medium text-xs shadow-xs transition-colors disabled:opacity-50"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
                  <span>Discover</span>
                </button>

                {/* Phase 2: Bulk Reboot Button */}
                <button
                  onClick={handleBulkReboot}
                  disabled={actionLoading}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-amber-50 text-amber-800 border border-amber-300 font-medium text-xs shadow-xs transition-colors disabled:opacity-50"
                  title="Initiate controlled reboot for selected hosts"
                >
                  <Power className="w-3.5 h-3.5 text-amber-600" />
                  <span>Reboot ({selectedIds.length})</span>
                </button>

                {/* Phase 2: Bulk Reset WU Cache */}
                {servers.filter((s) => selectedIds.includes(s.id) && s.os_family === "windows").length > 0 && (
                  <button
                    onClick={handleBulkResetCache}
                    disabled={actionLoading}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-indigo-50 text-indigo-800 border border-indigo-300 font-medium text-xs shadow-xs transition-colors disabled:opacity-50"
                    title="Clean and reset Windows Update cache on selected Windows hosts"
                  >
                    <Wrench className="w-3.5 h-3.5 text-indigo-600" />
                    <span>Reset WU Cache ({servers.filter((s) => selectedIds.includes(s.id) && s.os_family === "windows").length})</span>
                  </button>
                )}

                {/* Bulk Assign Customer Dropdown */}
                <div className="relative" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => setIsBulkCustomerOpen(!isBulkCustomerOpen)}
                    disabled={actionLoading}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-indigo-700 border border-indigo-200 font-medium text-xs shadow-xs transition-colors disabled:opacity-50"
                  >
                    <Building2 className="w-3.5 h-3.5 text-indigo-600" />
                    <span>Assign Customer...</span>
                  </button>

                  {isBulkCustomerOpen && (
                    <div className="absolute right-0 mt-1 w-52 bg-white rounded-xl shadow-lg border border-slate-200 py-1.5 z-50 text-xs">
                      <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Choose Customer
                      </div>
                      <div className="px-3 py-1.5 border-b border-slate-100 bg-slate-50/50">
                        <label className="flex items-center space-x-1.5 text-[11px] text-slate-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={bulkApplyDefaults}
                            onChange={(e) => setBulkApplyDefaults(e.target.checked)}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          <span className="font-medium">Apply Default Credentials</span>
                        </label>
                      </div>
                      <button
                        onClick={() => handleBulkAssignCustomer(null)}
                        className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-600 font-medium flex items-center justify-between"
                      >
                        <span>None (Unassigned)</span>
                      </button>
                      {groups.map((g) => (
                        <button
                          key={g.id}
                          onClick={() => handleBulkAssignCustomer(g.id)}
                          className="w-full text-left px-3 py-1.5 hover:bg-indigo-50 text-slate-800 font-medium flex items-center space-x-2"
                        >
                          <Building2 className="w-3 h-3 text-indigo-500" />
                          <span className="truncate">{g.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            <button
              onClick={() => setSelectedIds([])}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-white rounded-lg transition-colors"
              title="Clear selection"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Endpoints Data Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <th className="py-3 px-3 w-10 text-center">
                  <input
                    type="checkbox"
                    checked={
                      filteredServers.length > 0 &&
                      filteredServers.every((s) => selectedIds.includes(s.id))
                    }
                    onChange={toggleSelectAll}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="py-3 px-3">Endpoint Name</th>
                <th className="py-3 px-3">IP Address</th>
                <th className="py-3 px-3">Customer</th>
                <th className="py-3 px-3">OS Details</th>
                <th className="py-3 px-3">Status</th>
                <th className="py-3 px-3">Reboot</th>
                <th className="py-3 px-3">Pending Updates</th>
                <th className="py-3 px-3">AWX Credential</th>
                <th className="py-3 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredServers.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    <ServerIcon className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-1" />
                    <p className="font-medium text-slate-600">No managed endpoints matched your filter criteria.</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">Try clearing filters or adding a new server.</p>
                  </td>
                </tr>
              ) : (
                filteredServers.map((server) => {
                  const isSelected = selectedIds.includes(server.id);
                  const isOnline = server.connection_status === 'online';
                  const isUnreachable = server.connection_status === 'unreachable';
                  const customerName = getCustomerName(server.group_id);

                  return (
                    <tr
                      key={server.id}
                      className={`hover:bg-slate-50 transition-colors duration-150 ${
                        isSelected ? 'bg-blue-50/40' : ''
                      } ${!server.is_managed ? 'opacity-60 bg-slate-50/50' : ''}`}
                    >
                      {/* Checkbox */}
                      <td className="py-2.5 px-3 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(server.id)}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>

                      {/* Endpoint Name */}
                      <td className="py-3 px-3">
                        <div className="flex items-center space-x-2">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              server.os_family === 'windows' ? 'bg-sky-500' : 'bg-amber-600'
                            }`}
                            title={server.os_family === 'windows' ? 'Windows' : 'Linux'}
                          />
                          <button
                            onClick={() => setSelectedServer(server)}
                            className="font-medium text-sm text-slate-800 hover:text-blue-600 transition-colors text-left"
                          >
                            {server.hostname}
                          </button>
                          {!server.is_managed && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200 text-slate-600 font-mono">
                              Retired
                            </span>
                          )}
                        </div>
                      </td>

                      {/* IP Address */}
                      <td className="py-2.5 px-3 font-mono text-slate-600">
                        {server.ip_address}
                      </td>

                      {/* Customer / Group Badge */}
                      <td className="py-3 px-3">
                        {server.group_id ? (
                          <button
                            onClick={() => setCustomerFilter(String(server.group_id))}
                            className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 font-medium text-[11px] hover:bg-indigo-100 transition-colors"
                            title={`Filter by ${customerName}`}
                          >
                            <Building2 className="w-3 h-3 text-indigo-500 shrink-0" />
                            <span className="max-w-[120px] truncate">{customerName}</span>
                          </button>
                        ) : (
                          <span className="text-slate-400 text-[11px] italic">Unassigned</span>
                        )}
                      </td>

                      {/* OS Details */}
                      <td className="py-2.5 px-3 text-slate-700">
                        <div className="max-w-[180px] truncate" title={server.os_name || 'Not discovered'}>
                          {server.os_name || (server.os_family === 'windows' ? 'Windows' : 'Linux')}
                        </div>
                        {server.os_version && (
                          <div className="text-[10px] text-slate-400 font-mono truncate">
                            {server.os_version}
                          </div>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-3 px-3">
                        {isOnline ? (
                          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            <span>Online</span>
                          </span>
                        ) : isUnreachable ? (
                          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[11px] font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                            <span>Unreachable</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 text-[11px] font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                            <span>Offline</span>
                          </span>
                        )}
                      </td>

                      {/* Reboot */}
                      <td className="py-3 px-3">
                        {server.reboot_required ? (
                          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200 font-semibold text-[11px]">
                            <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
                            <span>Reboot Required</span>
                          </span>
                        ) : (
                          <span className="text-slate-500 text-[11px]">Clean</span>
                        )}
                      </td>

                      {/* Pending Updates */}
                      <td className="py-3 px-3">
                        {!server.discovery_fresh ? (
                          <span className="inline-flex items-center space-x-1 text-slate-400 text-[11px]">
                            <span>Needs discovery</span>
                          </span>
                        ) : server.security_updates_count > 0 ? (
                          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-200 font-bold text-[11px]">
                            <ShieldAlert className="w-3 h-3 shrink-0" />
                            <span>{server.security_updates_count} Security</span>
                          </span>
                        ) : server.pending_updates_count > 0 ? (
                          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200 font-semibold text-[11px]">
                            <span>{server.pending_updates_count} Updates</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center space-x-1 text-emerald-700 font-medium text-[11px]">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                            <span>Up-to-date</span>
                          </span>
                        )}
                      </td>

                      {/* AWX Credential */}
                      <td className="py-2.5 px-3 text-slate-600 text-[11px] max-w-[140px] truncate" title={getCredentialName(server.awx_credential_id)}>
                        {getCredentialName(server.awx_credential_id)}
                      </td>

                      {/* Actions Column (Action1 style 3-dots Context Menu) */}
                      <td className="py-2.5 px-3 text-right">
                        <div className="relative inline-block text-left" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => setActionModalServer(server)}
                            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                            title="Actions menu"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>


                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Customer Creation Modal */}
      {isAddCustomerOpen && (
        <div
          className="fixed inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
          onClick={() => { setIsAddCustomerOpen(false); setEditingCustomer(null); }}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-200 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: 'scaleIn 0.2s ease-out' }}
          >
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center space-x-2">
                <Building2 className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-slate-900 text-sm">Add Customer Organization</h3>
              </div>
              <button
                onClick={() => setIsAddCustomerOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateCustomer} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Customer Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Acme Corp, Globex Financial, Initech"
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Description / SLA Notes
                </label>
                <textarea
                  rows={2}
                  placeholder="Optional customer notes, account manager, or maintenance window..."
                  value={newCustomerDesc}
                  onChange={(e) => setNewCustomerDesc(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
                />
              </div>

              <div className="pt-2 border-t border-slate-100">
                <div className="text-xs font-bold text-slate-800 mb-1">
                  Default Customer Credentials (Inheritance)
                </div>
                <p className="text-[11px] text-slate-500 mb-3">
                  Any new server assigned to this customer will automatically inherit these credentials based on OS type.
                </p>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Default Linux Machine Credential (SSH)
                    </label>
                    <select
                      value={newCustomerLinuxCred}
                      onChange={(e) => setNewCustomerLinuxCred(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
                    >
                      <option value="">No Default (Prompt Manually)</option>
                      {awxCredentials
                        .filter((c) => c.os_compatibility === 'linux' || c.os_compatibility === 'all')
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} (ID: {c.id}) {c.os_compatibility === 'linux' ? '• Linux/SSH' : ''}
                          </option>
                        ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Default Windows Machine Credential (WinRM)
                    </label>
                    <select
                      value={newCustomerWinCred}
                      onChange={(e) => setNewCustomerWinCred(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600"
                    >
                      <option value="">No Default (Prompt Manually)</option>
                      {awxCredentials
                        .filter((c) => c.os_compatibility === 'windows' || c.os_compatibility === 'all')
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} (ID: {c.id}) {c.os_compatibility === 'windows' ? '• Windows/WinRM' : ''}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddCustomerOpen(false)}
                  className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 font-medium text-xs transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={customerSubmitting || !newCustomerName.trim()}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-xs shadow-sm transition-colors disabled:opacity-50"
                >
                  {customerSubmitting ? 'Saving...' : editingCustomer ? 'Update Customer' : 'Save Customer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add / Edit Server Modal */}
      {isAddServerOpen && (
        <div
          className="fixed inset-0 bg-slate-900/40 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
          onClick={() => { setIsAddServerOpen(false); setEditingServer(null); }}
        >
          <div
            className="bg-white rounded-2xl max-w-lg w-full shadow-2xl border border-slate-200 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: 'scaleIn 0.2s ease-out' }}
          >
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center space-x-2">
                <ServerIcon className="w-5 h-5 text-blue-600" />
                <h3 className="font-bold text-slate-900 text-sm">
                  {editingServer ? `Edit ${editingServer.hostname}` : 'Add Managed Server'}
                </h3>
              </div>
              <button
                onClick={() => setIsAddServerOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveServer} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Hostname *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. linux-01"
                    value={newHostname}
                    onChange={(e) => setNewHostname(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    IP Address *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 10.20.0.10"
                    value={newIp}
                    onChange={(e) => setNewIp(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    OS Family *
                  </label>
                  <select
                    value={newOsFamily}
                    onChange={(e) => {
                      const newOs = e.target.value as 'linux' | 'windows';
                      setNewOsFamily(newOs);
                      autoInheritCredential(newGroupId, newOs);
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  >
                    <option value="linux">Linux (SSH)</option>
                    <option value="windows">Windows (WinRM HTTPS)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Customer Organization
                  </label>
                  <select
                    value={newGroupId}
                    onChange={(e) => {
                      const grpId = e.target.value;
                      setNewGroupId(grpId);
                      autoInheritCredential(grpId, newOsFamily);
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  >
                    <option value="">None (Unassigned)</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center space-x-2">
                    <label className="block text-xs font-semibold text-slate-700">
                      AWX Machine Credential *
                    </label>
                    <span className="text-[10px] font-mono px-1.5 py-0.2 bg-slate-100 text-slate-600 rounded">
                      {showAllCredentials ? 'Showing all' : `Filtered for ${newOsFamily === 'windows' ? 'WinRM' : 'SSH'}`}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={() => setShowAllCredentials(!showAllCredentials)}
                      className="text-[11px] text-indigo-600 hover:text-indigo-800 underline"
                    >
                      {showAllCredentials ? 'Show OS-only' : `Show all (${awxCredentials.length})`}
                    </button>
                    <button
                      type="button"
                      onClick={refreshCredentials}
                      className="text-[11px] text-blue-600 hover:text-blue-800 flex items-center space-x-1"
                    >
                      <RefreshCw className={`w-3 h-3 ${refreshingCreds ? 'animate-spin' : ''}`} />
                      <span>Sync AWX</span>
                    </button>
                  </div>
                </div>

                {(() => {
                  const filteredCreds = awxCredentials.filter((c) => {
                    if (showAllCredentials) return true;
                    if (newOsFamily === 'windows') {
                      return c.os_compatibility === 'windows' || c.os_compatibility === 'all';
                    } else {
                      return c.os_compatibility === 'linux' || c.os_compatibility === 'all';
                    }
                  });

                  const selectedGroup = groups.find((g) => String(g.id) === String(newGroupId));
                  const isInherited =
                    selectedGroup &&
                    ((newOsFamily === 'windows' && String(selectedGroup.default_windows_credential_id) === String(newAwxCredentialId)) ||
                      (newOsFamily === 'linux' && String(selectedGroup.default_linux_credential_id) === String(newAwxCredentialId)));

                  return (
                    <>
                      <select
                        value={newAwxCredentialId}
                        onChange={(e) => setNewAwxCredentialId(e.target.value)}
                        className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 ${
                          isInherited
                            ? 'border-emerald-300 bg-emerald-50/20 focus:ring-emerald-500/20 focus:border-emerald-600'
                            : 'border-slate-300 focus:ring-blue-500/20 focus:border-blue-600'
                        }`}
                      >
                        <option value="">Select an AWX Machine credential...</option>
                        {filteredCreds.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} (ID: {c.id}) {c.os_compatibility === 'windows' ? '• WinRM' : c.os_compatibility === 'linux' ? '• SSH' : ''}
                          </option>
                        ))}
                      </select>

                      {isInherited && (
                        <div className="flex items-center space-x-1 mt-1 text-[11px] text-emerald-700 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                          <span>
                            Auto-inherited default from customer <strong className="font-semibold">{selectedGroup.name}</strong> ({newOsFamily === 'windows' ? 'WinRM' : 'SSH'})
                          </span>
                        </div>
                      )}

                      {!isInherited && selectedGroup && (
                        <p className="text-[11px] text-slate-400 mt-1">
                          Select a credential, or pick customer defaults to inherit automatically.
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>

              {newOsFamily === 'windows' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center space-x-1.5">
                    <Lock className="w-3.5 h-3.5 text-emerald-600" />
                    <span>WinRM TLS Certificate Verification</span>
                  </label>
                  <select
                    value={newWinrmCertValidation}
                    onChange={(e) => setNewWinrmCertValidation(e.target.value as '' | 'validate' | 'ignore')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  >
                    <option value="">Platform Default (Inherit global AWX policy)</option>
                    <option value="validate">Strict CA Validation (Enterprise / PatchOps Root CA — Recommended)</option>
                    <option value="ignore">Allow Self-Signed Certificates (Workgroup / Lab Nodes)</option>
                  </select>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Use <strong>Strict CA Validation</strong> when the target host&apos;s WinRM listener uses an Enterprise AD CS or PatchOps Root CA certificate to prevent internal MITM attacks.
                  </p>
                </div>
              )}

              {/* Target Onboarding Prerequisite Note */}
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Terminal className="w-4 h-4 text-indigo-600" />
                    <span className="text-xs font-semibold text-slate-900">
                      {newOsFamily === 'windows' ? 'Windows Target Setup (WinRM HTTPS 5986)' : 'Linux Target Setup (OpenSSH & Python 3)'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(newOsFamily === 'windows' ? WINRM_SETUP_SCRIPT : LINUX_SETUP_SCRIPT, 'modal')}
                    className={`inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 shadow-xs cursor-pointer ${
                      copiedKey === 'modal'
                        ? 'bg-emerald-600 hover:bg-emerald-700 text-white ring-2 ring-emerald-400 ring-offset-1 scale-105 shadow-emerald-200'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white hover:scale-102 active:scale-95'
                    }`}
                  >
                    {copiedKey === 'modal' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-white animate-bounce" />
                        <span>Copied to Clipboard!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy 1-Liner</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  {newOsFamily === 'windows'
                    ? 'Run this 1-line script in PowerShell as Administrator on the target Windows node to configure WinRM HTTPS, self-signed cert, and open firewall port 5986:'
                    : 'Ensure OpenSSH and Python 3 are installed on the target Linux host before running discovery or patching:'}
                </p>
                <div
                  onClick={() => copyToClipboard(newOsFamily === 'windows' ? WINRM_SETUP_SCRIPT : LINUX_SETUP_SCRIPT, 'modal')}
                  className="cursor-pointer relative group"
                  title="Click to copy script"
                >
                  <pre className="font-mono text-[10px] bg-slate-900 group-hover:bg-slate-950 text-indigo-200 group-hover:text-white p-2.5 rounded-lg overflow-x-auto select-all leading-tight whitespace-pre-wrap break-all max-h-24 border border-slate-800 transition-colors">
                    {newOsFamily === 'windows' ? WINRM_SETUP_SCRIPT : LINUX_SETUP_SCRIPT}
                  </pre>
                  <div className="absolute right-2 bottom-2 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800/90 text-indigo-300 text-[9px] font-mono px-1.5 py-0.5 rounded border border-slate-700 pointer-events-none">
                    Click to copy
                  </div>
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddServerOpen(false)}
                  className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 font-medium text-xs transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!newHostname || !newIp}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-sm transition-colors disabled:opacity-50"
                >
                  {editingServer ? 'Save Changes' : 'Create Server'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Target Node Setup & Onboarding Guide Modal */}
      {isSetupGuideOpen && (
        <div
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
          onClick={() => setIsSetupGuideOpen(false)}
        >
          <div
            className="bg-white rounded-2xl max-w-2xl w-full shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: 'scaleIn 0.2s ease-out' }}
          >
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center space-x-2.5">
                <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600 border border-indigo-200">
                  <Terminal className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">Target Node Setup & Onboarding Guide</h3>
                  <p className="text-xs text-slate-500">Prerequisite setup commands for managed hosts before running discovery or patching.</p>
                </div>
              </div>
              <button
                onClick={() => setIsSetupGuideOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-5">
              {/* OS Tabs */}
              <div className="flex space-x-2 border-b border-slate-200 pb-2">
                <button
                  type="button"
                  onClick={() => setSetupGuideOs('windows')}
                  className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center space-x-2 transition-all ${
                    setupGuideOs === 'windows'
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                  }`}
                >
                  <span>🪟 Windows Target (WinRM HTTPS - Port 5986)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSetupGuideOs('linux')}
                  className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center space-x-2 transition-all ${
                    setupGuideOs === 'linux'
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                  }`}
                >
                  <span>🐧 Linux Target (OpenSSH & Python 3)</span>
                </button>
              </div>

              {setupGuideOs === 'windows' ? (
                <div className="space-y-4">
                  <div className="p-3.5 rounded-xl bg-amber-50/80 border border-amber-200 text-amber-900 text-xs leading-relaxed">
                    <div className="font-semibold mb-1 flex items-center space-x-1.5 text-amber-950">
                      <AlertTriangle className="w-4 h-4 text-amber-700" />
                      <span>Windows WinRM Requirement</span>
                    </div>
                    AWX connects to Windows machines via <strong>WinRM HTTPS on port 5986</strong>. Target machines must have an HTTPS listener, self-signed TLS certificate, and the firewall port open.
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-slate-700">
                        1-Click PowerShell Setup Script (Run as Administrator on Windows Node)
                      </label>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(WINRM_SETUP_SCRIPT, 'guide-win')}
                        className={`inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 shadow-xs cursor-pointer ${
                          copiedKey === 'guide-win'
                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white ring-2 ring-emerald-400 ring-offset-1 scale-105 shadow-emerald-200'
                            : 'bg-indigo-600 hover:bg-indigo-700 text-white hover:scale-102 active:scale-95'
                        }`}
                      >
                        {copiedKey === 'guide-win' ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-white animate-bounce" />
                            <span>Copied to Clipboard!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copy Command</span>
                          </>
                        )}
                      </button>
                    </div>
                    <div
                      onClick={() => copyToClipboard(WINRM_SETUP_SCRIPT, 'guide-win')}
                      className="cursor-pointer relative group"
                      title="Click to copy script"
                    >
                      <pre className="font-mono text-xs bg-slate-900 group-hover:bg-slate-950 text-indigo-200 group-hover:text-white p-3 rounded-xl overflow-x-auto select-all leading-relaxed whitespace-pre-wrap break-all border border-slate-800 transition-colors">
                        {WINRM_SETUP_SCRIPT}
                      </pre>
                      <div className="absolute right-3 bottom-3 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800/90 text-indigo-300 text-[10px] font-mono px-2 py-0.5 rounded border border-slate-700 pointer-events-none">
                        Click to copy
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs text-slate-600">
                    <div className="font-semibold text-slate-800">What this script configures automatically:</div>
                    <ul className="list-disc list-inside space-y-1 pl-1 text-[11.5px]">
                      <li>Generates a self-signed TLS certificate for the target hostname.</li>
                      <li>Creates the WinRM HTTPS Listener bound to <code>0.0.0.0:5986</code>.</li>
                      <li>Adds Windows Defender Firewall inbound allow rule for TCP port 5986.</li>
                      <li>Enables <code>LocalAccountTokenFilterPolicy</code> so local admin credentials bypass UAC remote token filtering.</li>
                      <li>Restarts the WinRM service.</li>
                    </ul>
                  </div>

                  <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200 text-emerald-950 text-xs space-y-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="font-semibold flex items-center space-x-1.5">
                        <ShieldCheck className="w-4 h-4 text-emerald-700" />
                        <span>Enterprise / Internal Root CA Hardening (MITM Protection)</span>
                      </div>
                      <a
                        href="/api/health/ca.crt"
                        download="patchops-root-ca.crt"
                        className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold transition-colors shadow-xs"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download PatchOps Root CA (.crt)</span>
                      </a>
                    </div>
                    <p className="text-[11.5px] text-emerald-900 leading-relaxed">
                      Workgroup nodes can start with self-signed certificates above, while production Enterprise hosts should bind port <code>5986</code> to a certificate issued by your <strong>Active Directory Certificate Services (AD CS)</strong> or <strong>PatchOps Root CA</strong>, then set <strong>WinRM TLS Certificate Verification → Strict CA Validation</strong> in the server configuration.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono text-slate-600">
                    <span className="font-semibold text-slate-800">Verify Connectivity from Management Server:</span>
                    <pre className="mt-1 text-[11px] text-slate-800">nc -zv &lt;TARGET_IP&gt; 5986  # or PowerShell: Test-NetConnection &lt;TARGET_IP&gt; -Port 5986</pre>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-3.5 rounded-xl bg-blue-50/80 border border-blue-200 text-blue-900 text-xs leading-relaxed">
                    <div className="font-semibold mb-1 flex items-center space-x-1.5 text-blue-950">
                      <Terminal className="w-4 h-4 text-blue-700" />
                      <span>Linux Requirement</span>
                    </div>
                    AWX connects to Linux machines via standard <strong>OpenSSH (Port 22)</strong>. Ansible requires <strong>Python 3</strong> to be installed on the target machine for discovery and package manager execution.
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-slate-700">
                        1-Click Bash Setup Command (Debian/Ubuntu/RHEL/Rocky/AlmaLinux/CentOS)
                      </label>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(LINUX_SETUP_SCRIPT, 'guide-linux')}
                        className={`inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 shadow-xs cursor-pointer ${
                          copiedKey === 'guide-linux'
                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white ring-2 ring-emerald-400 ring-offset-1 scale-105 shadow-emerald-200'
                            : 'bg-indigo-600 hover:bg-indigo-700 text-white hover:scale-102 active:scale-95'
                        }`}
                      >
                        {copiedKey === 'guide-linux' ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-white animate-bounce" />
                            <span>Copied to Clipboard!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copy Command</span>
                          </>
                        )}
                      </button>
                    </div>
                    <div
                      onClick={() => copyToClipboard(LINUX_SETUP_SCRIPT, 'guide-linux')}
                      className="cursor-pointer relative group"
                      title="Click to copy script"
                    >
                      <pre className="font-mono text-xs bg-slate-900 group-hover:bg-slate-950 text-emerald-300 group-hover:text-emerald-200 p-3 rounded-xl overflow-x-auto select-all leading-relaxed whitespace-pre-wrap break-all border border-slate-800 transition-colors">
                        {LINUX_SETUP_SCRIPT}
                      </pre>
                      <div className="absolute right-3 bottom-3 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800/90 text-emerald-300 text-[10px] font-mono px-2 py-0.5 rounded border border-slate-700 pointer-events-none">
                        Click to copy
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs text-slate-600">
                    <div className="font-semibold text-slate-800">Prerequisites & Sudo Configuration:</div>
                    <ul className="list-disc list-inside space-y-1 pl-1 text-[11.5px]">
                      <li>Installs OpenSSH server and Python 3.</li>
                      <li>Enables and starts the <code>sshd</code> system service.</li>
                      <li>Ensures the Ansible service user has passwordless or sudo privileges for package managers (apt, dnf, yum, zypper).</li>
                    </ul>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono text-slate-600">
                    <span className="font-semibold text-slate-800">Verify Connectivity from Management Server:</span>
                    <pre className="mt-1 text-[11px] text-slate-800">ssh -i &lt;key&gt; &lt;user&gt;@&lt;TARGET_IP&gt; 'python3 --version'</pre>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 flex justify-end">
              <button
                type="button"
                onClick={() => setIsSetupGuideOpen(false)}
                className="px-4 py-2 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-medium transition-colors"
              >
                Close Guide
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Host 360° Slide-Over Drawer */}
      {selectedServer && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150"
          onClick={() => setSelectedServer(null)}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl border border-slate-200 flex flex-col max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: 'scaleIn 0.2s ease-out' }}
          >
            <div>
              {/* Modal Header */}
              <div className="px-6 py-5 border-b border-slate-100 flex items-start justify-between">
                <div>
                  <div className="flex items-center space-x-2">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        selectedServer.connection_status === 'online'
                          ? 'bg-emerald-500'
                          : selectedServer.connection_status === 'unreachable'
                          ? 'bg-amber-500'
                          : 'bg-slate-400'
                      }`}
                    />
                    <h3 className="font-bold text-slate-900 text-base font-mono">
                      {selectedServer.hostname}
                    </h3>
                  </div>
                  <p className="text-xs font-mono text-slate-500 mt-1">{selectedServer.ip_address}</p>
                  <div className="mt-2 flex items-center space-x-2">
                    <span className="text-[11px] px-2 py-0.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 font-medium flex items-center space-x-1">
                      <Building2 className="w-3 h-3 text-indigo-500" />
                      <span>{getCustomerName(selectedServer.group_id)}</span>
                    </span>
                    <span className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-mono">
                      {selectedServer.os_family}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedServer(null)}
                  className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-6 space-y-6">
                {/* Telemetry Overview */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">
                    System Telemetry
                  </h4>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                      <div className="text-slate-400 text-[10px] font-mono mb-1">CPU Cores</div>
                      <div className="text-slate-800 font-bold">{selectedServer.cpu_cores || 'N/A'} Cores</div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                      <div className="text-slate-400 text-[10px] font-mono mb-1">RAM</div>
                      <div className="text-slate-800 font-bold">
                        {selectedServer.ram_total_mb
                          ? `${(selectedServer.ram_total_mb / 1024).toFixed(1)} GB`
                          : 'N/A'}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                      <div className="text-slate-400 text-[10px] font-mono mb-1">Storage Free</div>
                      <div className="text-slate-800 font-bold">
                        {selectedServer.disk_available_gb
                          ? `${selectedServer.disk_available_gb.toFixed(1)} GB`
                          : 'N/A'}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                      <div className="text-slate-400 text-[10px] font-mono mb-1">Package Manager</div>
                      <div className="text-slate-800 font-bold font-mono">
                        {selectedServer.package_manager || 'N/A'}
                      </div>
                    </div>
                  </div>
                </div>

                {/* OS Details */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">
                    Operating System
                  </h4>
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Release:</span>
                      <span className="text-slate-900 font-medium">{selectedServer.os_name || 'Unknown'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Build / Version:</span>
                      <span className="text-slate-900 font-mono">{selectedServer.os_version || 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Architecture:</span>
                      <span className="text-slate-900 font-mono">{selectedServer.architecture || 'x86_64'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Last Discovered:</span>
                      <span className="text-slate-900 font-mono">
                        {selectedServer.last_discovered_at
                          ? formatUtcDate(selectedServer.last_discovered_at)
                          : 'Never'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Patch & Security Health */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">
                    Patch Health & Compliance
                  </h4>
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500">Security Updates:</span>
                      <span className="font-bold text-rose-700">
                        {selectedServer.security_updates_count} Pending
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500">Total Updates:</span>
                      <span className="font-bold text-amber-700">
                        {selectedServer.pending_updates_count} Packages
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500">Reboot Required:</span>
                      <div className="flex items-center space-x-2">
                        <span
                          className={`font-semibold ${
                            selectedServer.reboot_required ? 'text-amber-700 font-bold' : 'text-emerald-700'
                          }`}
                        >
                          {selectedServer.reboot_required ? 'Yes (Pending Reboot)' : 'Clean'}
                        </span>
                        {selectedServer.reboot_required && canOperate && (
                          <button
                            onClick={() => handleClearRebootFlag(selectedServer.id, selectedServer.hostname)}
                            className="text-[10px] text-blue-600 hover:underline font-mono px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200"
                            title="Clear pending reboot flag"
                          >
                            Clear Flag
                          </button>
                        )}
                      </div>
                    </div>
                    {selectedServer.os_family === 'windows' && (
                      <div className="flex justify-between items-center pt-1 border-t border-slate-200/70">
                        <span className="text-slate-500">WinRM TLS Policy:</span>
                        <span
                          className={`inline-flex items-center space-x-1 font-semibold ${
                            selectedServer.winrm_cert_validation === 'validate'
                              ? 'text-emerald-700'
                              : 'text-slate-600'
                          }`}
                        >
                          <Lock className="w-3 h-3" />
                          <span>
                            {selectedServer.winrm_cert_validation === 'validate'
                              ? 'Strict CA Validation'
                              : selectedServer.winrm_cert_validation === 'ignore'
                              ? 'Self-Signed Allowed'
                              : 'Platform Default'}
                          </span>
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Target Node Setup & Onboarding Script */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">
                    Target Node Onboarding
                  </h4>
                  <div className="p-3.5 rounded-xl bg-indigo-50/50 border border-indigo-100 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-1.5 font-semibold text-slate-800 text-xs">
                        <Terminal className="w-3.5 h-3.5 text-indigo-600" />
                        <span>{selectedServer.os_family === 'windows' ? 'WinRM HTTPS Setup (5986)' : 'OpenSSH / Python 3 Setup'}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(selectedServer.os_family === 'windows' ? WINRM_SETUP_SCRIPT : LINUX_SETUP_SCRIPT, 'drawer')}
                        className={`inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all duration-200 shadow-xs cursor-pointer ${
                          copiedKey === 'drawer'
                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white ring-2 ring-emerald-400 ring-offset-1 scale-105 shadow-emerald-200'
                            : 'bg-indigo-600 hover:bg-indigo-700 text-white hover:scale-102 active:scale-95'
                        }`}
                      >
                        {copiedKey === 'drawer' ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-white animate-bounce" />
                            <span>Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            <span>Copy 1-Liner</span>
                          </>
                        )}
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      {selectedServer.os_family === 'windows'
                        ? 'Run in PowerShell as Administrator on target to configure WinRM HTTPS on port 5986.'
                        : 'Run on target Linux machine to ensure OpenSSH and Python 3 prerequisites.'}
                    </p>
                  </div>
                </div>

                {/* Installed Patch History */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">
                      Installed Patch History ({installedPatches.length})
                    </h4>
                    {installedPatches.length > 0 && (
                      <div className="relative w-44">
                        <Search className="w-3 h-3 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={patchSearch}
                          onChange={(e) => setPatchSearch(e.target.value)}
                          placeholder="Filter KB / package…"
                          className="w-full pl-7 pr-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-[11px] text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-500"
                        />
                      </div>
                    )}
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50/50 overflow-hidden">
                    {patchesLoading ? (
                      <div className="py-6 text-center text-xs text-slate-400 font-mono">
                        Loading installed patches…
                      </div>
                    ) : installedPatches.length === 0 ? (
                      <div className="py-6 px-4 text-center text-xs text-slate-400">
                        No installed patch records captured for this endpoint yet.
                      </div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto divide-y divide-slate-100">
                        {installedPatches
                          .filter((p) =>
                            !patchSearch.trim() ||
                            p.package_or_kb.toLowerCase().includes(patchSearch.trim().toLowerCase()) ||
                            (p.build_id || '').toLowerCase().includes(patchSearch.trim().toLowerCase())
                          )
                          .map((p) => (
                            <div key={p.id} className="px-3.5 py-2.5 bg-white hover:bg-slate-50/80 flex items-center justify-between gap-2 text-xs">
                              <div className="min-w-0 flex-1">
                                <div className="font-mono font-semibold text-slate-800 truncate" title={p.package_or_kb}>
                                  {p.package_or_kb}
                                </div>
                                <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-2">
                                  <span>{formatUtcDate(p.installed_at)}</span>
                                  {p.build_id && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const bId = p.build_id!;
                                        setSelectedServer(null);
                                        onNavigateToBuild(bId);
                                      }}
                                      className="text-blue-600 hover:underline"
                                    >
                                      {p.build_id}
                                    </button>
                                  )}
                                </div>
                              </div>
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase font-semibold shrink-0 border ${
                                  p.patch_type === 'security'
                                    ? 'bg-rose-50 text-rose-700 border-rose-200'
                                    : 'bg-blue-50 text-blue-700 border-blue-200'
                                }`}
                              >
                                {p.patch_type}
                              </span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Drawer Footer Actions */}
            {canOperate && (
              <div className="p-6 border-t border-slate-200 bg-slate-50 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      handleSingleServerLaunch('security', selectedServer);
                      setSelectedServer(null);
                    }}
                    className="w-full py-2 px-3 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium text-xs shadow-xs transition-colors flex items-center justify-center space-x-1.5"
                  >
                    <ShieldAlert className="w-3.5 h-3.5" />
                    <span>Patch Security</span>
                  </button>

                  <button
                    onClick={() => {
                      handleSingleServerLaunch('regular', selectedServer);
                      setSelectedServer(null);
                    }}
                    className="w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-xs transition-colors flex items-center justify-center space-x-1.5"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Patch Regular</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      handleRebootServer(selectedServer.id, selectedServer.hostname);
                      setSelectedServer(null);
                    }}
                    className="w-full py-2 px-3 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 font-medium text-xs shadow-xs transition-colors flex items-center justify-center space-x-1.5"
                  >
                    <Power className="w-3.5 h-3.5 text-amber-600" />
                    <span>Reboot Server</span>
                  </button>

                  <button
                    onClick={() => {
                      handleSingleServerLaunch('discovery', selectedServer);
                      setSelectedServer(null);
                    }}
                    className="w-full py-2 px-3 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 font-medium text-xs shadow-xs transition-colors flex items-center justify-center space-x-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
                    <span>Run Discovery</span>
                  </button>
                </div>

                {selectedServer.os_family === "windows" && (
                  <button
                    onClick={() => {
                      handleResetCache(selectedServer.id, selectedServer.hostname);
                      setSelectedServer(null);
                    }}
                    className="w-full py-2 px-3 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 font-medium text-xs shadow-xs transition-colors flex items-center justify-center space-x-1.5"
                  >
                    <Wrench className="w-3.5 h-3.5 text-indigo-600" />
                    <span>Clean & Reset Windows Update Cache</span>
                  </button>
                )}


              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ Endpoint Actions Modal (centered, backdrop blur) ═══════════ */}
      {actionModalServer && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 backdrop-blur-md"
          onClick={() => setActionModalServer(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-[scaleIn_0.2s_ease-out]"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: 'scaleIn 0.2s ease-out' }}
          >
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Endpoint Actions</h3>
                <p className="text-sm text-slate-500 mt-0.5">
                  {actionModalServer.hostname}{' '}
                  <span className="text-slate-400">•</span>{' '}
                  <span className="font-mono text-xs">{actionModalServer.ip_address}</span>
                </p>
              </div>
              <button
                onClick={() => setActionModalServer(null)}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Action Grid */}
            <div className="p-5 space-y-2">
              {/* Operations Section */}
              {canOperate && actionModalServer.is_managed && (
                <>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Operations</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => {
                        const s = actionModalServer;
                        setActionModalServer(null);
                        handleSingleServerLaunch('security', s);
                      }}
                      className="flex items-center space-x-2.5 px-4 py-3 rounded-xl border border-rose-200 bg-rose-50/50 hover:bg-rose-100 text-rose-700 font-medium text-sm transition-all hover:shadow-sm"
                    >
                      <ShieldAlert className="w-4 h-4 shrink-0" />
                      <span>Patch Security</span>
                    </button>
                    <button
                      onClick={() => {
                        const s = actionModalServer;
                        setActionModalServer(null);
                        handleSingleServerLaunch('regular', s);
                      }}
                      className="flex items-center space-x-2.5 px-4 py-3 rounded-xl border border-blue-200 bg-blue-50/50 hover:bg-blue-100 text-blue-700 font-medium text-sm transition-all hover:shadow-sm"
                    >
                      <ShieldCheck className="w-4 h-4 shrink-0" />
                      <span>Patch Regular</span>
                    </button>
                    <button
                      onClick={() => {
                        const s = actionModalServer;
                        setActionModalServer(null);
                        handleSingleServerLaunch('discovery', s);
                      }}
                      className="flex items-center space-x-2.5 px-4 py-3 rounded-xl border border-slate-200 bg-slate-50/50 hover:bg-slate-100 text-slate-700 font-medium text-sm transition-all hover:shadow-sm"
                    >
                      <RefreshCw className="w-4 h-4 shrink-0" />
                      <span>Run Discovery</span>
                    </button>
                    <button
                      onClick={() => {
                        const s = actionModalServer;
                        setActionModalServer(null);
                        handleRebootServer(s.id, s.hostname);
                      }}
                      className="flex items-center space-x-2.5 px-4 py-3 rounded-xl border border-amber-200 bg-amber-50/50 hover:bg-amber-100 text-amber-700 font-medium text-sm transition-all hover:shadow-sm"
                    >
                      <Power className="w-4 h-4 shrink-0" />
                      <span>Reboot</span>
                    </button>
                  </div>
                </>
              )}

              {/* Management Section */}
              <div className="pt-3 border-t border-slate-100 mt-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Management</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      const s = actionModalServer;
                      setActionModalServer(null);
                      setSelectedServer(s);
                    }}
                    className="flex items-center space-x-2.5 px-4 py-3 rounded-xl border border-indigo-200 bg-indigo-50/50 hover:bg-indigo-100 text-indigo-700 font-medium text-sm transition-all hover:shadow-sm"
                  >
                    <ExternalLink className="w-4 h-4 shrink-0" />
                    <span>Telemetry 360°</span>
                  </button>
                  {canOperate && (
                    <>
                      <button
                        onClick={() => {
                          const s = actionModalServer;
                          setActionModalServer(null);
                          openEditServer(s);
                        }}
                        className="flex items-center space-x-2.5 px-4 py-3 rounded-xl border border-emerald-200 bg-emerald-50/50 hover:bg-emerald-100 text-emerald-700 font-medium text-sm transition-all hover:shadow-sm"
                      >
                        <Pencil className="w-4 h-4 shrink-0" />
                        <span>Edit & Assign</span>
                      </button>
                      <button
                        onClick={() => {
                          setActionModalServer(null);
                          setSetupGuideOs(actionModalServer!.os_family as 'windows' | 'linux');
                          setIsSetupGuideOpen(true);
                        }}
                        className="flex items-center space-x-2.5 px-4 py-3 rounded-xl border border-violet-200 bg-violet-50/50 hover:bg-violet-100 text-violet-700 font-medium text-sm transition-all hover:shadow-sm"
                      >
                        <Terminal className="w-4 h-4 shrink-0" />
                        <span>Setup Command</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Admin Danger Zone */}
              {isAdmin && (
                <div className="pt-3 border-t border-slate-100 mt-3 space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-rose-400 mb-2">Admin Zone</p>
                  {actionModalServer.is_managed && actionModalServer.os_family === 'linux' && (
                    <button
                      onClick={() => {
                        const s = actionModalServer;
                        setActionModalServer(null);
                        setConfirmMajorUpgrade(false);
                        setConfirmBackupVerified(false);
                        setMajorUpgradeServer(s);
                      }}
                      className="w-full flex items-center space-x-2.5 px-4 py-2.5 rounded-xl border border-purple-200 bg-purple-50/50 hover:bg-purple-100 text-purple-800 font-medium text-sm transition-colors text-left"
                    >
                      <Layers className="w-4 h-4 text-purple-600 shrink-0" />
                      <span>Major OS Release Upgrade (Gated)</span>
                    </button>
                  )}
                  {actionModalServer.is_managed ? (
                    <button
                      onClick={() => {
                        const s = actionModalServer;
                        setActionModalServer(null);
                        handleDeleteServer(s.id, s.hostname);
                      }}
                      className="w-full flex items-center space-x-2.5 px-4 py-2.5 rounded-xl hover:bg-rose-50 text-rose-600 font-medium text-sm transition-colors text-left"
                    >
                      <Trash2 className="w-4 h-4 text-rose-500 shrink-0" />
                      <span>Retire Server</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        const s = actionModalServer;
                        setActionModalServer(null);
                        handleRestoreServer(s);
                      }}
                      className="w-full flex items-center space-x-2.5 px-4 py-2.5 rounded-xl hover:bg-emerald-50 text-emerald-700 font-medium text-sm transition-colors text-left"
                    >
                      <RotateCcw className="w-4 h-4 text-emerald-500 shrink-0" />
                      <span>Restore Server</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════ Admin-Gated Major OS Upgrade Modal ═══════════ */}
      {majorUpgradeServer && (
        <div
          className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-900/40 backdrop-blur-md p-4"
          onClick={() => setMajorUpgradeServer(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-slate-200 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: 'scaleIn 0.2s ease-out' }}
          >
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-purple-50/40">
              <div className="flex items-center space-x-2.5">
                <div className="p-2 rounded-lg bg-purple-100 text-purple-700">
                  <Layers className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Major OS Release Upgrade</h3>
                  <p className="text-xs text-slate-500 font-mono">
                    {majorUpgradeServer.hostname} ({majorUpgradeServer.ip_address})
                  </p>
                </div>
              </div>
              <button
                onClick={() => setMajorUpgradeServer(null)}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleLaunchMajorUpgrade} className="p-6 space-y-4">
              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1">
                <div className="font-bold flex items-center space-x-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>High-Impact Distribution Upgrade Preflight</span>
                </div>
                <p className="text-amber-800 leading-relaxed">
                  The pipeline enforces at least <strong>25 GiB free root disk space</strong>, zero pending reboot markers, and a clean package database before executing an unattended release upgrade (<code className="font-mono">do-release-upgrade</code> / <code className="font-mono">leapp</code>) and reboot.
                </p>
              </div>

              <div className="space-y-2.5 text-xs text-slate-700">
                <label className="flex items-start space-x-2.5 p-3 rounded-xl border border-slate-200 hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmBackupVerified}
                    onChange={(e) => setConfirmBackupVerified(e.target.checked)}
                    className="mt-0.5 rounded border-slate-300 text-purple-600 focus:ring-purple-500"
                  />
                  <span>
                    <strong>Backup / Snapshot Verified:</strong> I confirm a restorable VM snapshot or full system backup exists for <strong>{majorUpgradeServer.hostname}</strong>.
                  </span>
                </label>

                <label className="flex items-start space-x-2.5 p-3 rounded-xl border border-slate-200 hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmMajorUpgrade}
                    onChange={(e) => setConfirmMajorUpgrade(e.target.checked)}
                    className="mt-0.5 rounded border-slate-300 text-purple-600 focus:ring-purple-500"
                  />
                  <span>
                    <strong>Administrator Authorization:</strong> I explicitly approve running an unattended major OS distribution upgrade and controlled reboot.
                  </span>
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setMajorUpgradeServer(null)}
                  className="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!confirmMajorUpgrade || !confirmBackupVerified || majorUpgradeSubmitting}
                  className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold shadow-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {majorUpgradeSubmitting ? 'Launching…' : 'Launch Major OS Upgrade'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
