# PatchOps Custom Execution Environment (EE)

## Why a Custom EE Is Required
The default upstream AWX Execution Environment (`quay.io/ansible/awx-ee:24.6.1`) does **not** bundle `community.general`. Without `community.general` installed in the AWX runtime, playbooks that reference `community.general.zypper` (even inside conditional `suse.yml` task files) fail on AWX when SUSE hosts are targeted or if collections are missing.

PatchOps provides two ways to supply the required collections (`ansible.windows`, `ansible.posix`, `community.general >= 8.3.0`):

1. **Fast Path — Custom Execution Environment (Recommended, ~2s AWX Project Sync):**
   Bake the collections directly into a custom container image using `execution-environment/execution-environment.yml` and `ansible/collections/requirements.ee.yml`.
2. **Slow Fallback — Automatic Galaxy Sync (~3m AWX Project Sync):**
   `ansible/collections/requirements.yml` stays in the playbooks repository so standard AWX Project Syncs automatically download `community.general`, `ansible.windows`, and `ansible.posix` from Ansible Galaxy into the default EE without extra image builds. *(If you adopt the Custom EE fast path and want ~2s project syncs without Galaxy downloads on every run, you can remove `ansible/collections/requirements.yml` in your deployment fork after your Job Templates point to the custom EE.)*

---

## Build and Push the Custom EE

Run on a Linux/macOS workstation or CI runner with `ansible-builder` (>=3.0) and `podman` or `docker`:

```bash
pip install ansible-builder
ansible-builder build \
  -f execution-environment/execution-environment.yml \
  --context ./context \
  -t <your-registry>/patchops-ee:24.6.1

# Push to your container registry (podman or docker)
podman push <your-registry>/patchops-ee:24.6.1
# or: docker push <your-registry>/patchops-ee:24.6.1
```

If using a private registry, create a **Container Registry** credential in AWX first (**Resources → Credentials → Add**).

---

## Configure AWX Job Templates to Use the Custom EE

1. In AWX UI, go to **Administration → Execution Environments → Add**.
2. Set:
   - **Name:** `PatchOps Custom EE 24.6.1`
   - **Image:** `<your-registry>/patchops-ee:24.6.1`
   - **Pull:** `Missing` (or `Always` during updates)
   - **Registry credential:** your registry credential (if private)
3. Open each of the four PatchOps Job Templates (**Resources → Templates**) and set **Execution Environment** to `PatchOps Custom EE 24.6.1`:
   - `Template-OS-Discovery` (`playbooks/discovery.yml`)
   - `Template-Security-Patching` (`playbooks/patch_security.yml`)
   - `Template-Regular-Patching` (`playbooks/patch_regular.yml`)
   - `Template-Major-OS-Upgrade` (`playbooks/upgrade_major_os.yml`)
