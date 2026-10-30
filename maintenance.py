"""macOS may report the same Korean path in composed or decomposed Unicode."""
import unicodedata


def command_contains(command: str, path: str) -> bool:
    return unicodedata.normalize('NFC', path) in unicodedata.normalize('NFC', command)
