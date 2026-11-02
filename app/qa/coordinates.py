"""Coordinate boundary between comparison images and live document CSS pixels."""

def reference_placement(capture: dict, metrics: dict) -> dict:
    clip = capture.get('clip', {})
    return {'x': clip.get('x', 0), 'y': clip.get('y', 0) + metrics['reference_top'] - metrics['actual_top']}


def reference_rect(rect: dict, metrics: dict) -> dict:
    return {**rect, 'y': rect['y'] - metrics['reference_top']}
