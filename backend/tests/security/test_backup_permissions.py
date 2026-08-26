"""Issue 23 regression test: scripts/backup.sh must not leave backup
artifacts group/world readable.

Actually invoking the script requires a live Docker Compose stack (Postgres,
the named volumes, a running `postgres` service), which this suite does not
have -- so this pins the *script's own guarantees* instead: a restrictive
umask is set before anything is created, the destination directory is
tightened explicitly (covering a pre-existing, caller-supplied path), and
every archive/dump produced by a *separate* container (whose own umask this
script cannot control) is chmod'd afterwards.
"""

from __future__ import annotations

from pathlib import Path

BACKUP_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "backup.sh"


def _script_text() -> str:
    return BACKUP_SCRIPT.read_text()


def test_backup_script_exists() -> None:
    assert BACKUP_SCRIPT.is_file()


def test_umask_is_set_before_the_destination_directory_is_created() -> None:
    # Search actual command lines, not the explanatory comment above `umask
    # 077` (which also quotes `mkdir -p "$destination"` in backticks).
    lines = [line.strip() for line in _script_text().splitlines()]
    umask_index = lines.index("umask 077")
    mkdir_index = lines.index('mkdir -p "$destination"')
    assert umask_index < mkdir_index, (
        "umask 077 must be set before mkdir -p \"$destination\" -- a umask set "
        "afterwards would not affect a directory that already exists"
    )


def test_destination_directory_is_explicitly_tightened() -> None:
    assert 'chmod 700 "$destination"' in _script_text()


def test_archives_produced_by_the_helper_container_are_chmodded() -> None:
    # `tar` runs inside a separate alpine container with its own umask, so the
    # host script's `umask 077` cannot govern these files -- they must be
    # tightened explicitly once they land on the host.
    text = _script_text()
    assert 'chmod 600 "$destination_abs/files.tar.gz"' in text
    assert 'chmod 600 "$destination_abs/pdfs.tar.gz"' in text


def test_environment_copy_is_chmodded() -> None:
    assert 'chmod 600 "$destination_abs/environment.env"' in _script_text()
