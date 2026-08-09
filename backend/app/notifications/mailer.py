from __future__ import annotations

import smtplib
from email.message import EmailMessage

from app.core.config import Settings
from app.notifications.templates import RenderedEmail


def send_smtp_email(
    settings: Settings,
    *,
    recipient: str,
    rendered: RenderedEmail,
) -> None:
    if not settings.smtp_host or not settings.smtp_from_address:
        raise RuntimeError("SMTP is not configured")

    message = EmailMessage()
    message["From"] = settings.smtp_from_address
    message["To"] = recipient
    message["Subject"] = rendered.subject
    message.set_content(rendered.text_body)
    message.add_alternative(rendered.html_body, subtype="html")

    smtp_class = smtplib.SMTP_SSL if settings.smtp_use_ssl else smtplib.SMTP
    with smtp_class(
        settings.smtp_host,
        settings.smtp_port,
        timeout=settings.smtp_timeout_seconds,
    ) as smtp:
        if settings.smtp_starttls:
            smtp.starttls()
        if settings.smtp_username:
            smtp.login(settings.smtp_username, settings.smtp_password or "")
        smtp.send_message(message)
