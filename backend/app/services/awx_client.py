import json
import logging
import ssl
from typing import Any, Dict, Iterable, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from app.config import settings

logger = logging.getLogger(__name__)


class AWXClientError(RuntimeError):
    """An AWX request failed, optionally with the controller's HTTP status."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class AWXClient:
    """Small AWX REST client. It never falls back to a fabricated local result."""

    def __init__(self) -> None:
        self.base_url = (settings.AWX_URL or "").rstrip("/")
        self.api_url = f"{self.base_url}/api/v2" if self.base_url else ""
        self.token = settings.AWX_TOKEN
        self.verify_ssl = settings.AWX_VERIFY_SSL

    def _validate_configuration(self, require_auth: bool = True) -> None:
        if not self.base_url:
            raise AWXClientError("AWX_URL is not configured")
        if urlsplit(self.base_url).scheme != "https":
            raise AWXClientError("AWX_URL must use HTTPS")
        if require_auth and not self.token:
            raise AWXClientError("AWX_TOKEN is not configured")

    def _ssl_context(self) -> ssl.SSLContext:
        if not self.verify_ssl:
            return ssl._create_unverified_context()
        if settings.AWX_CA_BUNDLE:
            return ssl.create_default_context(cafile=settings.AWX_CA_BUNDLE)
        return ssl.create_default_context()

    def _request(self, url: str, method: str = "GET", data: Optional[Dict[str, Any]] = None,
                 require_auth: bool = True) -> Any:
        self._validate_configuration(require_auth=require_auth)
        base = urlsplit(self.api_url)
        target = urlsplit(url)
        if (target.scheme, target.netloc) != (base.scheme, base.netloc):
            raise AWXClientError("Refusing to send AWX credentials to a different origin")

        headers = {"Accept": "application/json"}
        if require_auth:
            headers["Authorization"] = f"Bearer {self.token}"
        body = None
        if data is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(data).encode("utf-8")

        request = Request(url, data=body, headers=headers, method=method)
        context = self._ssl_context()
        try:
            with urlopen(request, timeout=20, context=context) as response:
                content = response.read().decode("utf-8")
        except HTTPError as exc:
            # AWX validation failures explain which launch field was rejected.
            # The platform never submits a secret in these requests, but trim
            # the returned text before persisting it in an operator-visible log.
            try:
                error_body = exc.read().decode("utf-8", errors="replace")
                parsed_error = json.loads(error_body)
                detail = parsed_error.get("detail", parsed_error) if isinstance(parsed_error, dict) else parsed_error
                detail_text = json.dumps(detail, ensure_ascii=False, default=str)
            except Exception:
                detail_text = ""
            logger.warning("AWX request failed: method=%s path=%s status=%s", method, target.path, exc.code)
            message = f"AWX returned HTTP {exc.code} for {method} {target.path}"
            if detail_text:
                message += f": {detail_text[:1000]}"
            raise AWXClientError(message, status_code=exc.code) from None
        except (URLError, TimeoutError, OSError) as exc:
            logger.warning("AWX request failed: method=%s path=%s error=%s", method, target.path, type(exc).__name__)
            raise AWXClientError(f"AWX is unavailable for {method} {target.path}") from None

        if not content:
            return {}
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return content

    def call(self, endpoint: str, method: str = "GET", data: Optional[Dict[str, Any]] = None,
             require_auth: bool = True) -> Any:
        if endpoint.startswith("http://") or endpoint.startswith("https://"):
            url = endpoint
        else:
            url = f"{self.api_url}/{endpoint.lstrip('/')}"
        return self._request(url, method=method, data=data, require_auth=require_auth)

    def ping(self) -> Dict[str, Any]:
        return self.call("/ping/", require_auth=False)

    def get_job_template_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        query = urlencode({"name": name})
        result = self.call(f"/job_templates/?{query}")
        matches = [item for item in result.get("results", []) if item.get("name") == name]
        if len(matches) > 1:
            raise AWXClientError(f"Multiple AWX job templates are named '{name}'")
        return matches[0] if matches else None

    def get_credential_by_id(self, credential_id: int) -> Dict[str, Any]:
        result = self.call(f"/credentials/{credential_id}/")
        if not isinstance(result, dict) or result.get("id") != credential_id:
            raise AWXClientError(f"AWX did not return credential {credential_id}")
        return result

    def list_machine_credentials(self) -> list[Dict[str, Any]]:
        """Return selectable AWX Machine credentials without their secrets."""
        credentials = []
        for credential in self._paged_results("/credentials/?page_size=200&credential_type__kind=ssh"):
            if credential.get("kind") == "ssh" and isinstance(credential.get("id"), int):
                credentials.append({"id": credential["id"], "name": str(credential.get("name") or "")})
        return sorted(credentials, key=lambda item: (item["name"].casefold(), item["id"]))

    def sync_inventory_hosts(self, inventory_id: int, servers: list[Any]) -> int:
        """Create or update inventory hosts without storing machine credentials in AWX variables."""
        changed = 0
        for server in servers:
            variables = {
                "ansible_host": server.ip_address,
                "ansible_connection": "winrm" if server.os_family.value == "windows" else "ssh",
            }
            if server.os_family.value == "windows":
                cert_validation = (
                    getattr(server, "winrm_cert_validation", None)
                    or settings.AWX_WINDOWS_WINRM_SERVER_CERT_VALIDATION
                )
                variables.update({
                    "ansible_port": 5986,
                    "ansible_winrm_scheme": "https",
                    "ansible_winrm_transport": settings.AWX_WINDOWS_WINRM_TRANSPORT,
                    "ansible_winrm_server_cert_validation": cert_validation,
                })
            query = urlencode({"name": server.hostname, "inventory": inventory_id})
            result = self.call(f"/hosts/?{query}")
            matches = [
                host for host in result.get("results", [])
                if host.get("name") == server.hostname and host.get("inventory") == inventory_id
            ]
            payload = {
                "name": server.hostname,
                "inventory": inventory_id,
                "variables": json.dumps(variables),
            }
            if matches:
                host_id = matches[0]["id"]
                self.call(f"/hosts/{host_id}/", method="PATCH", data={"variables": payload["variables"]})
            else:
                self.call("/hosts/", method="POST", data=payload)
            changed += 1
        return changed

    def launch_job_template(self, template_id: int, extra_vars: Optional[Dict[str, Any]] = None,
                            limit: Optional[str] = None,
                            credential_ids: Optional[list[int]] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}
        if extra_vars:
            payload["extra_vars"] = extra_vars
        if limit:
            payload["limit"] = limit
        if credential_ids:
            payload["credentials"] = credential_ids
        result = self.call(f"/job_templates/{template_id}/launch/", method="POST", data=payload)
        if not isinstance(result, dict) or not result.get("job"):
            raise AWXClientError("AWX did not return a job ID after launch")
        return result

    def get_job_status(self, job_id: int) -> Dict[str, Any]:
        result = self.call(f"/jobs/{job_id}/")
        if not isinstance(result, dict) or "status" not in result:
            raise AWXClientError(f"AWX returned an invalid status for job {job_id}")
        return result

    def _paged_results(self, endpoint: str, max_pages: int = 1000) -> Iterable[Dict[str, Any]]:
        url = f"{self.api_url}/{endpoint.lstrip('/')}"
        page_count = 0
        while url:
            page_count += 1
            if page_count > max_pages:
                raise AWXClientError(f"AWX pagination exceeded {max_pages} pages")
            result = self._request(url)
            if not isinstance(result, dict):
                raise AWXClientError("AWX returned an invalid paginated response")
            yield from result.get("results", [])
            next_url = result.get("next")
            if not next_url:
                break
            url = next_url if next_url.startswith("https://") else f"{self.base_url}{next_url}"

    def get_job_events(self, job_id: int) -> list[Dict[str, Any]]:
        events = list(self._paged_results(f"/jobs/{job_id}/job_events/?page_size=200&order_by=id"))
        return sorted(events, key=lambda event: event.get("id", 0))

    def get_job_host_summaries(self, job_id: int) -> list[Dict[str, Any]]:
        return list(self._paged_results(f"/jobs/{job_id}/job_host_summaries/?page_size=200"))

    def get_job_stdout(self, job_id: int) -> str:
        self._validate_configuration(require_auth=True)
        url = f"{self.api_url}/jobs/{job_id}/stdout/?format=txt"
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "text/plain"}
        request = Request(url, headers=headers)
        context = self._ssl_context()
        try:
            with urlopen(request, timeout=30, context=context) as response:
                return response.read().decode("utf-8", errors="replace")
        except HTTPError as exc:
            raise AWXClientError(f"AWX returned HTTP {exc.code} while reading job stdout") from None
        except (URLError, TimeoutError, OSError) as exc:
            raise AWXClientError(f"AWX stdout is unavailable ({type(exc).__name__})") from None

    def cancel_job(self, job_id: int) -> Dict[str, Any]:
        result = self.call(f"/jobs/{job_id}/cancel/", method="POST", data={})
        if not isinstance(result, dict) or result.get("can_cancel") is False:
            raise AWXClientError(f"AWX did not accept cancellation for job {job_id}")
        return result


awx_client = AWXClient()
