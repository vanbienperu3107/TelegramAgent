#!/usr/bin/env python3
"""Buoc 1 cua deploy: kiem du secret VA repo variable truoc khi dung vao may nao.

    python3 scripts/check-deploy-secrets.py

Do o runner re hon do giua buoc 4 rat nhieu: luc do da ghi .env, sua
authorized_keys tren vpn6, tao DB, va keo image ve.

`vars.OPENCODE_TAG` / `vars.TUNNEL_TAG` la repo VARIABLE, khong phai secret, nen
chung khong nam trong bang secret — phai kiem rieng, neu khong `${...:?}` cua
compose se dung giua buoc 4.
"""
import os
import sys

# Secret ha tang, khong nam trong khuon .env.
INFRA = [
    "GHCR_TOKEN",
    "SSH_HOST_VPN4", "SSH_USER", "SSH_KEY",
    "SSH_HOST_VPN6", "SSH_USER_VPN6", "SSH_KEY_VPN6_B64",
    "VPN4_HOST_KEY_B64", "VPN6_HOST_KEY_B64", "PG_TUNNEL_KEY_B64",
]

# Secret cua ung dung — trung ten voi dong de trong trong .env*.example.
APP = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
    "TELEGRAM_ADMIN_USER_IDS",
    "OPENCODE_PG_PASSWORD",
    "OPENCODE_SERVER_PASSWORD",
    "CLIPROXY_API_KEY",
]

# Repo variable. Kiem rieng vi chung khong phai secret.
VARS = ["OPENCODE_TAG", "TUNNEL_TAG"]


def main():
    thieu = [n for n in INFRA + APP + VARS if not os.environ.get(n)]
    if thieu:
        for n in thieu:
            sys.stderr.write("::error::thieu %s\n" % n)
        sys.stderr.write(
            "\nSecret dat o Settings > Secrets and variables > Actions > Secrets.\n"
            "OPENCODE_TAG va TUNNEL_TAG la VARIABLES (tab ben canh), khong phai secret.\n"
        )
        return 1
    sys.stderr.write("OK: du %d secret + %d variable\n" % (len(INFRA) + len(APP), len(VARS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
