"""Administrative commands. Passwords are entered interactively and never logged."""

import argparse
import getpass
import sys

from app.database import SessionLocal
from app.models.models import RoleEnum, User
from app.services.auth_service import get_password_hash


def password_prompt() -> str:
    password = getpass.getpass("New admin password (12-72 UTF-8 bytes): ")
    confirmation = getpass.getpass("Confirm password: ")
    if password != confirmation:
        raise ValueError("Passwords do not match")
    if len(password) < 12 or len(password.encode("utf-8")) > 72:
        raise ValueError("Password must be 12-72 UTF-8 bytes")
    return password


def main() -> int:
    parser = argparse.ArgumentParser(description="Enterprise patching platform administration")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-admin", help="Create the first administrator account")
    create.add_argument("username")
    create.add_argument("--email")
    create.add_argument("--full-name")
    reset = commands.add_parser("reset-password", help="Interactively reset an account password")
    reset.add_argument("username")
    disable = commands.add_parser("disable-user", help="Disable an account without deleting its audit history")
    disable.add_argument("username")
    commands.add_parser("list-users", help="List account names, roles, and active state")
    args = parser.parse_args()

    try:
        db = SessionLocal()
        try:
            if args.command == "list-users":
                for user in db.query(User).order_by(User.username).all():
                    print(f"{user.username}\t{user.role.value}\t{'active' if user.is_active else 'disabled'}")
                return 0

            user = db.query(User).filter(User.username == args.username).first()
            if args.command == "disable-user":
                if not user:
                    raise ValueError("User not found")
                if user.role == RoleEnum.ADMIN and user.is_active:
                    active_admins = db.query(User).filter(
                        User.role == RoleEnum.ADMIN,
                        User.is_active.is_(True),
                    ).count()
                    if active_admins <= 1:
                        raise ValueError("Create or activate another administrator before disabling the last active administrator")
                user.is_active = False
                db.commit()
                print(f"Account '{args.username}' is disabled.")
                return 0

            password = password_prompt()
            if args.command == "create-admin":
                if user:
                    raise ValueError("Username already exists; use reset-password if you are rotating it")
                user = User(
                    username=args.username,
                    email=args.email,
                    full_name=args.full_name,
                    role=RoleEnum.ADMIN,
                    is_active=True,
                    password_hash=get_password_hash(password),
                )
                db.add(user)
            else:
                if not user:
                    raise ValueError("User not found")
                user.password_hash = get_password_hash(password)
                user.is_active = True
            db.commit()
        finally:
            db.close()
    except (ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"Administrator account '{args.username}' is ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
