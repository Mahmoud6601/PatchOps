import React, { useEffect, useState } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  KeyRound,
  Shield,
  ShieldCheck,
  Eye,
  UserCog,
  RefreshCw,
  Check,
  X,
  AlertTriangle,
  Building2,
  Layers,
} from 'lucide-react';
import { ServerGroup, User } from '../types';
import { api } from '../api';
import { formatUtcDate } from '../date';
import { useToast } from '../components/Toast';
import { ConfirmModal } from '../components/ConfirmModal';

const ROLE_CONFIG = {
  administrator: { label: 'Administrator', color: 'bg-rose-50 text-rose-700 border-rose-200', icon: Shield },
  operator:      { label: 'Operator',      color: 'bg-blue-50 text-blue-700 border-blue-200', icon: ShieldCheck },
  readonly:      { label: 'Read Only',     color: 'bg-slate-100 text-slate-600 border-slate-200', icon: Eye },
};

interface UsersPageProps {
  currentUser: User;
}

export const UsersPage: React.FC<UsersPageProps> = ({ currentUser }) => {
  const { success, error: toastError } = useToast();
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    variant: 'danger' | 'warning' | 'info';
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', confirmLabel: 'Confirm', variant: 'danger', onConfirm: () => {} });
  const closeConfirm = () => setConfirmModal((p) => ({ ...p, open: false }));
  const showConfirm = (
    title: string,
    message: string,
    confirmLabel: string,
    variant: 'danger' | 'warning' | 'info',
    onConfirm: () => void
  ) => {
    setConfirmModal({ open: true, title, message, confirmLabel, variant, onConfirm });
  };

  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<ServerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [showPasswordModal, setShowPasswordModal] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  // Form state
  const [formUsername, setFormUsername] = useState('');
  const [formFullName, setFormFullName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState<'administrator' | 'operator' | 'readonly'>('operator');
  const [formOsScope, setFormOsScope] = useState<'all' | 'linux' | 'windows'>('all');
  const [formCustomerMode, setFormCustomerMode] = useState<'all' | 'restricted'>('all');
  const [formGroupIds, setFormGroupIds] = useState<number[]>([]);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Password reset
  const [newPassword, setNewPassword] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const [userData, groupData] = await Promise.all([
        api.getUsers(),
        api.getServerGroups().catch(() => [] as ServerGroup[]),
      ]);
      setUsers(userData);
      setGroups(groupData);
    } catch (e: any) {
      toastError('Failed to load users', e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setEditingUser(null);
    setFormUsername('');
    setFormFullName('');
    setFormEmail('');
    setFormPassword('');
    setFormRole('operator');
    setFormOsScope('all');
    setFormCustomerMode('all');
    setFormGroupIds([]);
    setFormError('');
    setShowModal(true);
  };

  const openEdit = (u: User) => {
    setEditingUser(u);
    setFormUsername(u.username);
    setFormFullName(u.full_name || '');
    setFormEmail(u.email || '');
    setFormPassword('');
    setFormRole(u.role);
    if (u.allowed_os_families && u.allowed_os_families.length === 1) {
      setFormOsScope(u.allowed_os_families[0]);
    } else {
      setFormOsScope('all');
    }
    if (u.allowed_group_ids && u.allowed_group_ids.length > 0) {
      setFormCustomerMode('restricted');
      setFormGroupIds(u.allowed_group_ids);
    } else {
      setFormCustomerMode('all');
      setFormGroupIds([]);
    }
    setFormError('');
    setShowModal(true);
  };

  const toggleGroupId = (id: number) => {
    setFormGroupIds((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (formRole !== 'administrator' && formCustomerMode === 'restricted' && formGroupIds.length === 0) {
      setFormError('Select at least one Customer Organization, or switch Customer Scope to All Customers.');
      return;
    }

    const allowed_os_families: ('linux' | 'windows')[] | null =
      formRole === 'administrator' || formOsScope === 'all' ? null : [formOsScope];
    const allowed_group_ids: number[] | null =
      formRole === 'administrator' || formCustomerMode === 'all' ? null : formGroupIds;

    setFormSubmitting(true);
    try {
      if (editingUser) {
        await api.updateUser(editingUser.id, {
          full_name: formFullName.trim() || null,
          email: formEmail.trim() || null,
          role: formRole,
          allowed_os_families,
          allowed_group_ids,
        });
        success('User updated', `${editingUser.username} permissions and scope saved.`);
      } else {
        if (formPassword.length < 12) {
          setFormError('Password must be at least 12 characters.');
          setFormSubmitting(false);
          return;
        }
        await api.createUser({
          username: formUsername,
          full_name: formFullName || undefined,
          email: formEmail || undefined,
          password: formPassword,
          role: formRole,
          allowed_os_families,
          allowed_group_ids,
        });
        success('User created', `${formUsername} can now sign in.`);
      }
      setShowModal(false);
      load();
    } catch (e: any) {
      setFormError(e.message || 'Error saving user');
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleToggleActive = async (u: User) => {
    try {
      await api.updateUser(u.id, { is_active: !u.is_active });
      success(u.is_active ? 'User deactivated' : 'User reactivated', u.username);
      load();
    } catch (e: any) {
      toastError('Failed to update user', e.message);
    }
  };

  const handleDelete = (u: User) => {
    showConfirm('Delete User', `Permanently delete user "${u.username}"? This cannot be undone.`, 'Delete User', 'danger', async () => {
      closeConfirm();
      setDeleting(u.id);
      try {
        await api.deleteUser(u.id);
        success('User deleted', u.username);
        load();
      } catch (e: any) {
        toastError('Failed to delete user', e.message);
      } finally {
        setDeleting(null);
      }
    });
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!showPasswordModal) return;
    if (newPassword.length < 12) {
      toastError('Password too short', 'Must be at least 12 characters.');
      return;
    }
    setPwSubmitting(true);
    try {
      await api.resetUserPassword(showPasswordModal.id, newPassword);
      success('Password reset', `Password for ${showPasswordModal.username} has been updated.`);
      setShowPasswordModal(null);
      setNewPassword('');
    } catch (e: any) {
      toastError('Reset failed', e.message);
    } finally {
      setPwSubmitting(false);
    }
  };

  const groupNameMap = new Map(groups.map((g) => [g.id, g.name]));

  const renderUserScopeBadges = (u: User) => {
    if (u.role === 'administrator' || (!u.allowed_group_ids?.length && !u.allowed_os_families?.length)) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-slate-100 text-slate-600 border border-slate-200">
          Full Fleet Scope
        </span>
      );
    }
    return (
      <div className="flex flex-wrap gap-1">
        {u.allowed_os_families && u.allowed_os_families.length > 0 && (
          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-indigo-50 text-indigo-700 border border-indigo-200">
            <Layers className="w-2.5 h-2.5" />
            <span>{u.allowed_os_families.join(', ')} only</span>
          </span>
        )}
        {u.allowed_group_ids &&
          u.allowed_group_ids.map((gid) => (
            <span
              key={gid}
              className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-medium bg-cyan-50 text-cyan-800 border border-cyan-200"
            >
              <Building2 className="w-2.5 h-2.5" />
              <span>{groupNameMap.get(gid) || `Group #${gid}`}</span>
            </span>
          ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <ConfirmModal
        isOpen={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmLabel={confirmModal.confirmLabel}
        variant={confirmModal.variant}
        onConfirm={confirmModal.onConfirm}
        onCancel={closeConfirm}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Team &amp; Scoped RBAC Management</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Manage platform users, roles, and granular customer / OS environment boundaries.
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <button onClick={load} disabled={loading} className="p-2 rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-600' : ''}`} />
          </button>
          <button onClick={openCreate} className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm shadow-sm transition-colors">
            <Plus className="w-4 h-4" />
            <span>Add User</span>
          </button>
        </div>
      </div>

      {/* Role legend */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {Object.entries(ROLE_CONFIG).map(([role, cfg]) => {
          const Icon = cfg.icon;
          const count = users.filter((u) => u.role === role).length;
          return (
            <div key={role} className="flex items-center space-x-3 p-3 rounded-xl bg-white border border-slate-200 shadow-xs">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${cfg.color}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900">{cfg.label}</div>
                <div className="text-xs text-slate-500">{count} user{count !== 1 ? 's' : ''}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Users table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-3 px-6">User</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">RBAC Access Scope</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-6 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr><td colSpan={6} className="py-10 text-center text-slate-400 text-sm">Loading users…</td></tr>
              )}
              {!loading && users.map((u) => {
                const roleCfg = ROLE_CONFIG[u.role] || ROLE_CONFIG.readonly;
                const RoleIcon = roleCfg.icon;
                const isSelf = u.id === currentUser.id;
                return (
                  <tr key={u.id} className={`hover:bg-slate-50/60 transition-colors ${!u.is_active ? 'opacity-50' : ''}`}>
                    <td className="py-3.5 px-6">
                      <div className="flex items-center space-x-3">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold text-sm shadow-sm">
                          {(u.full_name || u.username).charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-semibold text-slate-900 flex items-center space-x-2">
                            <span>{u.full_name || u.username}</span>
                            {isSelf && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">You</span>}
                          </div>
                          <div className="text-xs text-slate-500 font-mono">{u.username}{u.email ? ` · ${u.email}` : ''}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${roleCfg.color}`}>
                        <RoleIcon className="w-3 h-3" />
                        <span>{roleCfg.label}</span>
                      </span>
                    </td>
                    <td className="py-3.5 px-4">{renderUserScopeBadges(u)}</td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium ${u.is_active ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${u.is_active ? 'bg-emerald-500' : 'bg-slate-400'}`}></span>
                        <span>{u.is_active ? 'Active' : 'Inactive'}</span>
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-500 whitespace-nowrap">{formatUtcDate(u.created_at)}</td>
                    <td className="py-3.5 px-6">
                      <div className="flex items-center justify-end space-x-1">
                        <button onClick={() => openEdit(u)} title="Edit user & RBAC scope" className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => { setShowPasswordModal(u); setNewPassword(''); }} title="Reset password" className="p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-colors">
                          <KeyRound className="w-3.5 h-3.5" />
                        </button>
                        {!isSelf && (
                          <>
                            <button onClick={() => handleToggleActive(u)} title={u.is_active ? 'Deactivate' : 'Activate'} className={`p-1.5 rounded-lg transition-colors ${u.is_active ? 'text-slate-400 hover:text-amber-600 hover:bg-amber-50' : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50'}`}>
                              {u.is_active ? <X className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                            </button>
                            <button onClick={() => handleDelete(u)} disabled={deleting === u.id} title="Delete user" className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors disabled:opacity-50">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Role Permissions Reference */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center space-x-2">
          <UserCog className="w-4 h-4 text-slate-500" />
          <span>Role Permissions &amp; Scoping Reference</span>
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-2 px-3 text-slate-500 font-semibold">Capability</th>
                <th className="text-center py-2 px-3 text-rose-600 font-semibold">Admin</th>
                <th className="text-center py-2 px-3 text-blue-600 font-semibold">Operator (Scoped)</th>
                <th className="text-center py-2 px-3 text-slate-500 font-semibold">Read Only (Scoped)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[
                ['View Dashboard, Inventory & Run History (within assigned Customer/OS scope)', true, true, true],
                ['Launch Discovery / Patch / Reboot / Cache Reset (within assigned scope)', true, true, false],
                ['Add / Edit Endpoints & Schedules (within assigned scope)', true, true, false],
                ['Create / Delete Customer Organizations', true, false, false],
                ['View Security Audit Trail', true, false, false],
                ['Manage Users & Scoped RBAC Assignments', true, false, false],
                ['Approve Overlapping Executions & Major OS Upgrades', true, false, false],
              ].map(([cap, admin, op, ro]) => (
                <tr key={cap as string} className="hover:bg-slate-50/50">
                  <td className="py-2 px-3 text-slate-700">{cap as string}</td>
                  <td className="py-2 px-3 text-center">{admin ? <Check className="w-3.5 h-3.5 text-emerald-600 mx-auto" /> : <X className="w-3.5 h-3.5 text-slate-300 mx-auto" />}</td>
                  <td className="py-2 px-3 text-center">{op ? <Check className="w-3.5 h-3.5 text-emerald-600 mx-auto" /> : <X className="w-3.5 h-3.5 text-slate-300 mx-auto" />}</td>
                  <td className="py-2 px-3 text-center">{ro ? <Check className="w-3.5 h-3.5 text-emerald-600 mx-auto" /> : <X className="w-3.5 h-3.5 text-slate-300 mx-auto" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create/Edit Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-md"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg max-h-[88vh] overflow-y-auto p-6"
            style={{ animation: 'scaleIn 0.18s ease-out' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-bold text-slate-900">
                {editingUser ? `Edit User — ${editingUser.username}` : 'Create New Team Member'}
              </h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            {formError && (
              <div className="mb-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start space-x-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              {!editingUser && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Username <span className="text-rose-500">*</span></label>
                  <input required value={formUsername} onChange={(e) => setFormUsername(e.target.value)} placeholder="john.doe" className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600" />
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Full Name</label>
                  <input value={formFullName} onChange={(e) => setFormFullName(e.target.value)} placeholder="John Doe" className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Email</label>
                  <input type="email" value={formEmail} onChange={(e) => setFormEmail(e.target.value)} placeholder="john@company.local" className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600" />
                </div>
              </div>
              {!editingUser && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Password <span className="text-rose-500">*</span> <span className="text-slate-400 font-normal">(min 12 chars)</span></label>
                  <input required type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} placeholder="••••••••••••" className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600" />
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Role</label>
                <select value={formRole} onChange={(e) => setFormRole(e.target.value as any)} className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600">
                  <option value="administrator">Administrator — Full Unrestricted Access</option>
                  <option value="operator">Operator — Patch, Reboot &amp; Schedule within Scope</option>
                  <option value="readonly">Read Only — View Dashboards &amp; Runs within Scope</option>
                </select>
              </div>

              {formRole !== 'administrator' && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-4">
                  <div className="flex items-center space-x-2 text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
                    <ShieldCheck className="w-4 h-4 text-blue-600" />
                    <span>Granular Access Scope (RBAC)</span>
                  </div>

                  {/* OS Family Restriction */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Operating System Environment Scope
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { id: 'all', label: 'All OS' },
                        { id: 'linux', label: '🐧 Linux Only' },
                        { id: 'windows', label: '🪟 Windows Only' },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setFormOsScope(opt.id as any)}
                          className={`py-2 px-2.5 rounded-lg text-xs font-semibold border transition-all ${
                            formOsScope === opt.id
                              ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Customer Group Restriction */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                      Customer Organization Scope
                    </label>
                    <div className="flex items-center gap-4 mb-2">
                      <label className="flex items-center space-x-2 text-xs text-slate-700 font-medium cursor-pointer">
                        <input
                          type="radio"
                          checked={formCustomerMode === 'all'}
                          onChange={() => setFormCustomerMode('all')}
                          className="text-blue-600 focus:ring-blue-500"
                        />
                        <span>All Customers (Unrestricted)</span>
                      </label>
                      <label className="flex items-center space-x-2 text-xs text-slate-700 font-medium cursor-pointer">
                        <input
                          type="radio"
                          checked={formCustomerMode === 'restricted'}
                          onChange={() => setFormCustomerMode('restricted')}
                          className="text-blue-600 focus:ring-blue-500"
                        />
                        <span>Specific Customer(s) Only</span>
                      </label>
                    </div>

                    {formCustomerMode === 'restricted' && (
                      <div className="max-h-36 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2.5 space-y-1.5">
                        {groups.length === 0 ? (
                          <p className="text-xs text-slate-400 py-2 text-center">No customer organizations exist yet.</p>
                        ) : (
                          groups.map((g) => (
                            <label key={g.id} className="flex items-center justify-between px-2 py-1 rounded hover:bg-slate-50 cursor-pointer text-xs">
                              <span className="flex items-center space-x-2 text-slate-800 font-medium">
                                <input
                                  type="checkbox"
                                  checked={formGroupIds.includes(g.id)}
                                  onChange={() => toggleGroupId(g.id)}
                                  className="rounded text-blue-600 focus:ring-blue-500"
                                />
                                <span>{g.name}</span>
                              </span>
                              <span className="text-[10px] font-mono text-slate-400">{g.server_count} hosts</span>
                            </label>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center space-x-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium text-sm hover:bg-slate-50 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={formSubmitting} className="flex-1 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm shadow-sm transition-colors disabled:opacity-50">
                  {formSubmitting ? 'Saving…' : editingUser ? 'Save Changes' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Password Reset Modal */}
      {showPasswordModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-md"
          onClick={() => setShowPasswordModal(null)}
        >
          <div
            className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-sm p-6"
            style={{ animation: 'scaleIn 0.18s ease-out' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">Reset Password</h3>
              <button onClick={() => setShowPasswordModal(null)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600 mb-4">Setting new password for <strong>{showPasswordModal.username}</strong>.</p>
            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">New Password <span className="text-slate-400">(min 12 chars)</span></label>
                <input required type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••••••" className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600" />
              </div>
              <div className="flex space-x-3">
                <button type="button" onClick={() => setShowPasswordModal(null)} className="flex-1 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium text-sm hover:bg-slate-50 transition-colors">Cancel</button>
                <button type="submit" disabled={pwSubmitting} className="flex-1 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white font-medium text-sm shadow-sm transition-colors disabled:opacity-50">
                  {pwSubmitting ? 'Resetting…' : 'Reset Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
