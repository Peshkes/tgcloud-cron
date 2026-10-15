# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Report privately through GitHub: **Security > Report a vulnerability** on this
repository. Do not open a public issue.

Include what an attacker can do, the steps to reproduce, and the affected
version. You should get a reply within 7 days.

**Never include a real `TGCLOUD_TOKEN` in a report.** If you think a token has
leaked, revoke it in @BotFather (your bot > Serverless > CLI Access) first.

## Scope

In scope: anything that could expose the CLI token, run code other than the
configured job, leak backup data, or let workflow inputs reach a shell.

Out of scope: the Telegram Serverless platform itself and its management
API. Report those to Telegram.
