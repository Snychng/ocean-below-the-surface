#!/usr/bin/env python3
"""按真实 PTS 对完整视频做 6 fps 最近帧采样，并生成带外置标签的 3×2 拼图。"""

# 复用工作区既有 PTS 采样器；平衡选择表达式，避免长视频超过 FFmpeg 表达式递归深度。
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from fractions import Fraction

from PIL import Image, ImageDraw, ImageFont


def execute(command: list[str]) -> str:
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr or f"Command exited {result.returncode}")
    return result.stdout


def timestamp(seconds: Fraction) -> str:
    milliseconds = round(float(seconds) * 1000)
    minutes, remainder = divmod(milliseconds, 60000)
    second, millisecond = divmod(remainder, 1000)
    return f"{minutes:02d}:{second:02d}.{millisecond:03d}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--base", type=Path, default=Path.cwd())
    parser.add_argument("--ffmpeg", default="/opt/homebrew/bin/ffmpeg")
    parser.add_argument("--ffprobe", default="/opt/homebrew/bin/ffprobe")
    args = parser.parse_args()
    source, output, base = args.source.resolve(), args.output.resolve(), args.base.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if output.exists() and any(output.iterdir()):
        raise RuntimeError(f"输出目录非空，请为本次参数创建新版本目录：{output}")

    metadata_command = [
        args.ffprobe, "-v", "error", "-show_entries",
        "format=duration:stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,duration,start_time:stream_side_data=rotation",
        "-of", "json", str(source),
    ]
    frames_command = [
        args.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "frame=best_effort_timestamp_time,pts_time,pkt_duration_time,width,height",
        "-of", "json", str(source),
    ]
    metadata = json.loads(execute(metadata_command))
    decoded_probe = json.loads(execute(frames_command))
    streams = [stream for stream in metadata["streams"] if stream.get("codec_type") == "video"]
    if not streams or not decoded_probe.get("frames"):
        raise RuntimeError("视频未返回可解码帧。")
    stream = streams[0]
    decoded = decoded_probe["frames"]
    pts = [Fraction(frame.get("best_effort_timestamp_time") or frame["pts_time"]) for frame in decoded]
    origin = min(pts)
    duration = Fraction(stream.get("duration") or metadata["format"]["duration"]) - origin
    if duration <= 0:
        raise RuntimeError("有效视频时长必须大于零。")
    targets = [Fraction(index, 6) for index in range(math.ceil(duration * 6))]
    targets = [target for target in targets if target < duration]
    # 按实际显示 PTS 选最近帧，距离相同时选择更早帧，不插值或补帧。
    selected = [min(range(len(pts)), key=lambda index: (abs(pts[index] - origin - target), pts[index], index)) for target in targets]
    unique_indices = sorted(set(selected))

    frames_dir, sheets_dir, decoded_dir = output / "frames", output / "sheets", output / "_decoded"
    for directory in (frames_dir, sheets_dir, decoded_dir):
        directory.mkdir(parents=True, exist_ok=True)
    def balanced_sum(terms):
        if len(terms) == 1:
            return terms[0]
        middle = len(terms) // 2
        return f"({balanced_sum(terms[:middle])}+{balanced_sum(terms[middle:])})"
    select_expression = balanced_sum([f"eq(n\\,{index})" for index in unique_indices])
    extraction_command = [
        args.ffmpeg, "-hide_banner", "-loglevel", "error", "-threads", "1", "-filter_threads", "1", "-i", str(source),
        "-map", "0:v:0", "-vf", f"select={select_expression}", "-fps_mode", "vfr",
        "-compression_level", "4", "-threads", "1", str(decoded_dir / "selected_%06d.png"),
    ]
    execute(extraction_command)
    decoded_files = sorted(decoded_dir.glob("selected_*.png"))
    if len(decoded_files) != len(unique_indices):
        raise RuntimeError(f"解码图像数不一致：{len(decoded_files)} != {len(unique_indices)}")
    decoded_paths = dict(zip(unique_indices, decoded_files))

    records = []
    first_source_use: dict[int, int] = {}
    for index, (target, source_index) in enumerate(zip(targets, selected), 1):
        filename = f"frame_{index:06d}.png"
        shutil.copyfile(decoded_paths[source_index], frames_dir / filename)
        duplicate_of = first_source_use.get(source_index)
        first_source_use.setdefault(source_index, index)
        sheet_index, cell = divmod(index - 1, 6)
        records.append({
            "index": index,
            "target_time_seconds": float(target),
            "target_time_fraction": f"{target.numerator}/{target.denominator}",
            "target_timestamp_label": timestamp(target),
            "source_decode_index": source_index,
            "source_pts_seconds": float(pts[source_index]),
            "source_time_seconds": float(pts[source_index] - origin),
            "sample_error_seconds": float(pts[source_index] - origin - target),
            "duplicate_source": duplicate_of is not None,
            "duplicate_of_frame": duplicate_of,
            "path": f"frames/{filename}",
            "sheet": f"sheets/sheet_{sheet_index + 1:06d}.png",
            "cell_index": cell,
            "cell_row": cell // 3,
            "cell_column": cell % 3,
        })

    with Image.open(frames_dir / "frame_000001.png") as first_image:
        display_width, display_height = first_image.size
    font_path = Path("/System/Library/Fonts/STHeiti Medium.ttc")
    if not font_path.is_file():
        font_path = Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")
    font = ImageFont.truetype(str(font_path), 25)
    empty_font = ImageFont.truetype(str(font_path), 40)
    label_height = 48
    cell_height = display_height + label_height
    sheet_records = []
    for sheet_index in range(math.ceil(len(records) / 6)):
        sheet = Image.new("RGB", (display_width * 3, cell_height * 2), "#e9e7e1")
        draw = ImageDraw.Draw(sheet)
        group = records[sheet_index * 6:(sheet_index + 1) * 6]
        for cell in range(6):
            x, y = cell % 3 * display_width, cell // 3 * cell_height
            if cell < len(group):
                record = group[cell]
                with Image.open(output / record["path"]) as frame_image:
                    if frame_image.size != (display_width, display_height):
                        raise RuntimeError("源视频显示尺寸发生改变，需要单独处理，未拉伸图像。")
                    sheet.paste(frame_image.convert("RGB"), (x, y + label_height))
                label = f"帧 {record['index']:06d}    {record['target_timestamp_label']}"
                draw.text((x + 16, y + 10), label, fill="#1e2528", font=font)
            else:
                draw.text((x + display_width / 2, y + cell_height / 2), "无后续帧", fill="#747470", font=empty_font, anchor="mm")
            draw.rectangle((x, y, x + display_width - 1, y + cell_height - 1), outline="#bdbdb4", width=1)
        sheet_path = f"sheets/sheet_{sheet_index + 1:06d}.png"
        sheet.save(output / sheet_path, compress_level=4)
        sheet_records.append({
            "index": sheet_index + 1,
            "path": sheet_path,
            "frames": [record["index"] for record in group],
            "empty_cells": 6 - len(group),
        })

    # 元数据与映射独立保留；全部可解码 PTS 可用于再次核验最近帧规则。
    (output / "source-probe.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    (output / "source-frame-pts.json").write_text(json.dumps({"origin_seconds": float(origin), "frames": decoded}, ensure_ascii=False, indent=2) + "\n")
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "relative_path": os.path.relpath(source, base),
            "base_directory": str(base),
            "absolute_path_at_execution": str(source),
            "source_url": None,
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "size_bytes": source.stat().st_size,
            "duration_seconds": float(duration),
            "pts_origin_seconds": float(origin),
            "coded_width": stream["width"],
            "coded_height": stream["height"],
            "display_width": display_width,
            "display_height": display_height,
            "rotation_degrees": next((entry.get("rotation", 0) for entry in stream.get("side_data_list", []) if "rotation" in entry), 0),
            "r_frame_rate": stream.get("r_frame_rate"),
            "avg_frame_rate": stream.get("avg_frame_rate"),
            "decoded_frame_count": len(decoded),
        },
        "sampling": {
            "fps": 6,
            "range": "覆盖全部有效视频时长，0 <= target < duration",
            "selection_rule": "以最早可解码帧 PTS 为零，逐目标时刻选择最近真实 PTS；距离相同时取更早帧，不做插值",
            "ffmpeg_autorotate": True,
            "sample_count": len(records),
            "unique_source_frame_count": len(unique_indices),
            "duplicate_sample_count": len(records) - len(unique_indices),
            "sheet_count": len(sheet_records),
            "sheet_layout": {"columns": 3, "rows": 2, "label_height": label_height, "cell_width": display_width, "cell_height": cell_height},
            "timestamp_note": "标签显示到毫秒，不代表源视频具有毫秒级时间精度。",
        },
        "execution": {
            "sampler_path": str(Path(__file__).resolve()),
            "python": sys.executable,
            "invocation": shlex.join([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]),
            "commands": [metadata_command, frames_command, extraction_command],
            "label_font": str(font_path),
        },
        "frames": records,
        "sheets": sheet_records,
        "validation": {
            "target_count_matches_ceil_duration_times_6": len(records) == math.ceil(duration * 6),
            "indices_contiguous": [record["index"] for record in records] == list(range(1, len(records) + 1)),
            "sheet_count_matches_ceil_samples_div_6": len(sheet_records) == math.ceil(len(records) / 6),
            "every_frame_in_exactly_one_sheet": sorted(index for sheet in sheet_records for index in sheet["frames"]) == list(range(1, len(records) + 1)),
            "tail_included": sheet_records[-1]["frames"][-1] == len(records),
            "visual_inspection": "待实际打开首组、中间组、尾组后记录，采样成功不代表画面正确。",
            "motion_limit": "6 fps 拼图仅提供状态演进证据，不能单独证明完整动效质量或高频过渡。",
        },
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    shutil.rmtree(decoded_dir)
    print(json.dumps({"output": str(output), "samples": len(records), "sheets": len(sheet_records), "duplicates": len(records) - len(unique_indices), "duration_seconds": float(duration)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
