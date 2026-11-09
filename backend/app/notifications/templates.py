from __future__ import annotations

from dataclasses import dataclass
from html import escape
from typing import Any


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    text_body: str
    html_body: str


def _paragraph_rows(paragraphs: list[str]) -> str:
    return "".join(
        '<tr><td style="padding:0 0 16px;color:#59667a;font-size:16px;'
        f'line-height:26px;mso-line-height-rule:exactly;">{escape(paragraph)}</td></tr>'
        for paragraph in paragraphs
    )


def _summary_row(summary_items: list[tuple[str, str, str]]) -> str:
    if not summary_items:
        return ""
    cell_width = f"{100 / len(summary_items):.0f}%"
    cells = "".join(
        f'<td width="{cell_width}" valign="top" style="padding:10px 12px;'
        f"{'border-right:1px solid #d9e0ec;' if index < len(summary_items) - 1 else ''}"
        'text-align:left;vertical-align:top;">'
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" '
        'border="0"><tr><td style="padding:0 0 3px;color:#7a8799;font-size:11px;'
        f'font-weight:700;letter-spacing:.06em;text-transform:uppercase;">{escape(label)}</td>'
        f'</tr><tr><td style="padding:0;color:{escape(color, quote=True)};font-size:18px;'
        f'font-weight:700;line-height:24px;">{escape(value)}</td></tr></table></td>'
        for index, (label, value, color) in enumerate(summary_items)
    )
    return (
        '<tr><td style="padding:8px 0 24px;">'
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" '
        'border="0" bgcolor="#f8f9fc" style="border:1px solid #d9e0ec;'
        f'border-radius:10px;background:#f8f9fc;border-collapse:separate;"><tr>{cells}</tr>'
        "</table></td></tr>"
    )


def _button(action_label: str, action_url: str) -> str:
    safe_label = escape(action_label)
    safe_url = escape(action_url, quote=True)
    return (
        '<tr><td style="padding:8px 0 0;mso-padding-alt:0;">'
        f'<!--[if mso]><v:roundrect href="{safe_url}" style="height:46px;'
        'v-text-anchor:middle;width:190px;" arcsize="20%" strokecolor="#5369d8" '
        'fillcolor="#5369d8"><w:anchorlock xmlns:w="urn:schemas-microsoft-com:office:word"/>'
        '<center style="color:#ffffff;font-family:Segoe UI,sans-serif;font-size:15px;'
        f'font-weight:bold;">{safe_label}</center></v:roundrect><![endif]-->'
        "<!--[if !mso]><!-->"
        f'<a href="{safe_url}" style="display:inline-block;border-radius:9px;'
        "background:#5369d8;padding:13px 20px;color:#ffffff;font-size:15px;font-weight:700;"
        f'line-height:20px;text-decoration:none;">{safe_label}</a><!--<![endif]--></td></tr>'
    )


def _brand() -> str:
    return (
        '<tr><td style="padding:0 4px 18px;">'
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>'
        '<td width="38" height="38" align="center" valign="middle" '
        'bgcolor="#5369d8" style="width:38px;height:38px;border-radius:10px;'
        "background:#5369d8;color:#ffffff;font-size:20px;font-weight:800;text-align:center;"
        'line-height:38px;mso-line-height-rule:exactly;">P</td>'
        '<td style="padding-left:11px;color:#172033;font-size:19px;font-weight:700;'
        'letter-spacing:-.02em;">Papertrail</td></tr></table></td></tr>'
    )


def _layout(
    title: str,
    paragraphs: list[str],
    action_label: str,
    action_url: str,
    *,
    summary_items: list[tuple[str, str, str]],
) -> str:
    safe_title = escape(title)
    safe_url = escape(action_url, quote=True)
    content = (
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">'
        '<tr><td style="padding:0 0 10px;color:#5369d8;font-size:12px;font-weight:700;'
        'letter-spacing:.1em;text-transform:uppercase;">Papertrail notification</td></tr>'
        f'<tr><td style="padding:0 0 22px;color:#172033;font-size:27px;font-weight:700;'
        f'line-height:34px;mso-line-height-rule:exactly;letter-spacing:-.025em;">{safe_title}'
        f"</td></tr>{_paragraph_rows(paragraphs)}{_summary_row(summary_items)}"
        f"{_button(action_label, action_url)}"
        '<tr><td style="padding:24px 0 0;color:#7a8799;font-size:12px;line-height:19px;">'
        "If the button does not work, copy and paste this address into your browser:<br>"
        f'<a href="{safe_url}" style="color:#5369d8;word-break:break-all;">{safe_url}</a>'
        "</td></tr></table>"
    )

    return (
        '<!doctype html><html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" '
        'xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="x-apple-disable-message-reformatting">'
        "<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch>"
        "<o:AllowPNG/></o:OfficeDocumentSettings></xml>"
        "<style>table{border-collapse:collapse;}</style><![endif]-->"
        f"<title>{safe_title}</title></head>"
        '<body style="margin:0;padding:0;background:#f4f6fb;color:#172033;'
        "font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\">"
        f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">'
        f"{safe_title}</div>"
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" '
        'bgcolor="#f4f6fb" style="background:#f4f6fb;">'
        '<tr><td align="center" style="padding:38px 16px;">'
        '<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" '
        'border="0"><tr><td><![endif]-->'
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" '
        f'style="width:100%;max-width:600px;">{_brand()}<tr><td>'
        '<table role="presentation" width="100%" cellspacing="0" '
        'cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;border:1px solid '
        "#d9e0ec;border-radius:16px;background:#ffffff;overflow:hidden;"
        "box-shadow:0 12px 30px rgba(23,32,51,.08);border-collapse:separate;"
        'mso-table-lspace:0;mso-table-rspace:0;">'
        '<tr><td height="4" bgcolor="#5369d8" style="height:4px;font-size:0;line-height:0;">'
        '&nbsp;</td></tr><tr><td style="padding:32px 38px 34px;'
        f'mso-padding-alt:32px 38px 34px;">{content}</td></tr></table>'
        '</td></tr><tr><td style="padding:18px 8px 0;color:#7a8799;font-size:12px;'
        'line-height:19px;text-align:center;">This automated message was sent by Papertrail.<br>'
        "</td></tr>"
        "</table><!--[if mso]></td></tr></table><![endif]-->"
        "</td></tr></table></body></html>"
    )


def render_email(template: str, context: dict[str, Any]) -> RenderedEmail:
    if template == "account_created":
        subject = "Your Papertrail account is ready"
        paragraphs = [
            f"Hello {context['recipient_name']},",
            f"An account has been created for you with username {context['username']}.",
            "For security, your temporary password is not included in this email. "
            "Ask your Papertrail administrator for it through a separate channel.",
        ]
        action_label = "Open Papertrail"
        action_url = context["login_url"]
        summary_items = [("Username", str(context["username"]), "#172033")]
    elif template == "password_reset":
        subject = "Reset your Papertrail password"
        paragraphs = [
            f"Hello {context['recipient_name']},",
            "We received a request to reset the password for your Papertrail account.",
            f"This link expires in {context['expires_in_minutes']} minutes and can only "
            "be used once. If you did not request this, you can safely ignore this email.",
        ]
        action_label = "Reset password"
        action_url = context["reset_url"]
        summary_items = []
    elif template == "project_created":
        subject = f'New project created: "{context["project_name"]}"'
        paragraphs = [
            f"Hello {context['recipient_name']},",
            f"{context['creator_name']} created the Papertrail project "
            f'"{context["project_name"]}".',
        ]
        action_label = "Open project"
        action_url = context["project_url"]
        summary_items = [("Project", str(context["project_name"]), "#172033")]
    elif template == "project_membership_added":
        subject = f'You were added to "{context["project_name"]}" '
        paragraphs = [
            f"Hello {context['recipient_name']},",
            f'You have been added to the Papertrail project "{context["project_name"]}".',
        ]
        action_label = "Open project"
        action_url = context["project_url"]
        summary_items = [("Project", str(context["project_name"]), "#172033")]
    elif template == "project_membership_removed":
        subject = f'Your membership of "{context["project_name"]}" ended'
        paragraphs = [
            f"Hello {context['recipient_name']},",
            f'You have been removed from the Papertrail project "{context["project_name"]}".',
        ]
        action_label = "Open Papertrail"
        action_url = context["home_url"]
        summary_items = [("Project", str(context["project_name"]), "#bf3f46")]
    elif template == "project_completed":
        subject = f'Project "{context["project_name"]}" is complete'
        paragraphs = [
            f"Hello {context['recipient_name']},",
            f'All workflow stages in the Papertrail project "{context["project_name"]}" '
            "have been completed.",
            "The completed project and its reports remain available in Papertrail.",
        ]
        action_label = "Open completed project"
        action_url = context["project_url"]
        summary_items = [("Status", "Completed", "#147a59")]
    elif template == "project_stage_completed":
        subject = f'"{context["stage_label"]}" complete in "{context["project_name"]}"'
        paragraphs = [
            f"Hello {context['recipient_name']},",
            f'The "{context["stage_label"]}" stage of the Papertrail project '
            f'"{context["project_name"]}" has been completed.',
            "The project has automatically advanced to its next stage: "
            f'"{context["new_stage_label"]}".',
        ]
        action_label = "Open project"
        action_url = context["project_url"]
        summary_items = [
            ("Stage complete", str(context["stage_label"]), "#147a59"),
            ("Now in progress", str(context["new_stage_label"]), "#5369d8"),
        ]
    elif template == "llm_stage_completed":
        subject = f'LLM processing bulk finished for "{context["project_name"]}"'
        paragraphs = [
            f"Hello {context['recipient_name']},",
            f'The complete queued LLM processing bulk in "{context["project_name"]}" '
            "has finished.",
            f"Tasks: {context['stage_label']}.",
            f"Completed: {context['completed_count']}. Failed: {context['failed_count']}. "
            f"Other terminal results: {context['other_count']}.",
        ]
        action_label = "Review LLM jobs"
        action_url = context["project_url"]
        summary_items = [
            ("Completed", str(context["completed_count"]), "#147a59"),
            ("Failed", str(context["failed_count"]), "#bf3f46"),
            ("Other", str(context["other_count"]), "#9d6712"),
        ]
    elif template == "project_copy_completed":
        subject = f'Your copy "{context["project_name"]}" is ready'
        paragraphs = [
            f"Hello {context['recipient_name']},",
            f'The Papertrail project "{context["source_project_name"]}" has been copied '
            f'into the new project "{context["project_name"]}". You are its owner.',
        ]
        if context.get("missing_files"):
            paragraphs.append(
                f"{context['missing_files']} file(s) were already missing from the source "
                "project and could not be copied."
            )
        action_label = "Open the copy"
        action_url = context["project_url"]
        summary_items = [("Status", "Copied", "#147a59")]
    elif template == "project_copy_failed":
        subject = f'Copying "{context["source_project_name"]}" failed'
        paragraphs = [
            f"Hello {context['recipient_name']},",
            f'Your copy "{context["project_name"]}" of the Papertrail project '
            f'"{context["source_project_name"]}" could not be created. Nothing was '
            "created and the source project is unchanged.",
            f"Reason: {context['error_message']}",
        ]
        action_label = "Open project administration"
        action_url = context["project_url"]
        summary_items = [("Status", "Failed", "#bf3f46")]
    else:
        raise ValueError(f"Unknown email template: {template}")

    subject = " ".join(subject.split())[:500]
    text_body = "\n\n".join([*paragraphs, f"{action_label}: {action_url}"])
    return RenderedEmail(
        subject=subject,
        text_body=text_body,
        html_body=_layout(
            subject,
            paragraphs,
            action_label,
            action_url,
            summary_items=summary_items,
        ),
    )
