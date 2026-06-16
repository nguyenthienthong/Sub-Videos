import argparse
import sys
import os
import json
import asyncio
import subprocess
import tempfile
import wave
import numpy as np
from faster_whisper import WhisperModel
from deep_translator import GoogleTranslator
import edge_tts
import imageio_ffmpeg
from google import genai

def print_progress(status, progress, message=""):
    print(json.dumps({"status": status, "progress": progress, "message": message}), flush=True)

def format_time(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    msecs = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{msecs:03d}"

VOICES = {
    'vi': 'vi-VN-HoaiMyNeural',
    'en': 'en-US-AriaNeural',
    'zh': 'zh-CN-XiaoxiaoNeural',
    'ja': 'ja-JP-NanamiNeural',
    'ko': 'ko-KR-SunHiNeural',
}

async def generate_tts(text, voice, output_file, retries=3):
    for attempt in range(retries):
        try:
            communicate = edge_tts.Communicate(text, voice)
            await communicate.save(output_file)
            return True
        except Exception as e:
            if attempt == retries - 1:
                print(f"TTS Error: {e}", file=sys.stderr)
                return False
            await asyncio.sleep(2)
    return False

def translate_text(text, source_lang, target_lang):
    if source_lang == target_lang or target_lang == "auto":
        return text
    try:
        translator = GoogleTranslator(source=source_lang, target=target_lang)
        return translator.translate(text)
    except Exception as e:
        return text

def get_wav_duration(wav_path):
    with wave.open(wav_path, 'rb') as f:
        frames = f.getnframes()
        rate = f.getframerate()
        return frames / float(rate)

def convert_mp3_to_wav(ffmpeg_exe, mp3_path, wav_path):
    cmd = [
        ffmpeg_exe, "-y", "-i", mp3_path,
        "-ar", "44100", "-ac", "1",
        "-c:a", "pcm_s16le",
        wav_path
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

async def process_video(video_path, output_path, model_size, target_language, mode, step, gemini_key):
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    json_path = output_path + ".json"
    
    if not os.path.exists(video_path):
        print_progress("error", 0, f"Không tìm thấy file: {video_path}")
        sys.exit(1)

    segments_data_list = []

    if step in ["1", "all"]:
        print_progress("init", 5, "Đang khởi tạo AI Model...")
        try:
            model = WhisperModel(model_size, device="cuda", compute_type="float16")
            print_progress("info", 10, "Sử dụng GPU (CUDA)")
        except Exception:
            model = WhisperModel(model_size, device="cpu", compute_type="int8")
            print_progress("info", 10, "Sử dụng CPU")

        print_progress("processing", 15, "Đang trích xuất giọng nói (Speech-to-Text)...")
        segments_generator, info = model.transcribe(video_path, beam_size=5)
        source_language = info.language

        print_progress("info", 10, f"Ngôn ngữ gốc: {source_language}")

        segments = []
        for segment in segments_generator:
            segments.append(segment)
            # Transcribe progress: from 10% to 30% (Step 1 half)
            if info.duration > 0:
                transcribe_prog = int(10 + (segment.end / info.duration) * 20)
                transcribe_prog = min(30, transcribe_prog)
                print_progress("processing", transcribe_prog, f"Đang nhận dạng giọng nói: {format_time(segment.end)}")

        original_texts = []
        for i, segment in enumerate(segments):
            segments_data_list.append({
                "id": i + 1,
                "start": segment.start,
                "end": segment.end,
                "original": segment.text.strip(),
                "translated": ""
            })
            original_texts.append(f"[{i + 1}] {segment.text.strip()}")

        if gemini_key and source_language != target_language and target_language != "auto":
            print_progress("processing", 30, "Đang dịch bằng AI Ngữ Cảnh (Gemini)...")
            try:
                client = genai.Client(api_key=gemini_key)
                
                script = "\n".join(original_texts)
                prompt = f"""
Translate the following movie subtitles from {source_language} to {target_language}.
Maintain the emotional tone, the context of the conversation, and the cinematic style.
Return the result strictly as a valid JSON array of objects. Each object must have:
- "id": the integer ID
- "translated": the translated string

Do NOT include any markdown blocks (like ```json), just output the raw JSON array.

Subtitles:
{script}
"""
                response = client.models.generate_content(
                    model='gemini-2.5-flash',
                    contents=prompt
                )
                response_text = response.text.strip()
                
                if response_text.startswith("```json"):
                    response_text = response_text[7:-3]
                elif response_text.startswith("```"):
                    response_text = response_text[3:-3]
                    
                translated_json = json.loads(response_text)
                
                for item in translated_json:
                    for seg in segments_data_list:
                        if seg["id"] == item["id"]:
                            seg["translated"] = item["translated"]
                            break
                            
            except Exception as e:
                print(f"Gemini error: {e}", file=sys.stderr)
                print_progress("processing", 30, "Lỗi Gemini, đang dùng Google Translate dự phòng...")
                for i, seg in enumerate(segments_data_list):
                    progress = int(30 + (i / max(len(segments_data_list), 1)) * 20)
                    print_progress("processing", progress, f"Đang dịch dự phòng đoạn {i+1}/{len(segments_data_list)}...")
                    seg["translated"] = translate_text(seg["original"], source_language, target_language)
        else:
            for i, seg in enumerate(segments_data_list):
                progress = int(30 + (i / max(len(segments_data_list), 1)) * 20)
                print_progress("processing", progress, f"Đang dịch đoạn {i+1}/{len(segments_data_list)}...")
                seg["translated"] = translate_text(seg["original"], source_language, target_language)

        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(segments_data_list, f, ensure_ascii=False, indent=2)
            
        if step == "1":
            print_progress("done", 50, "Hoàn tất bước dịch!")
            return
    else:
        # Step 2: Load from json
        if not os.path.exists(json_path):
            print_progress("error", 0, f"Không tìm thấy file dữ liệu: {json_path}")
            sys.exit(1)
        with open(json_path, "r", encoding="utf-8") as f:
            segments_data_list = json.load(f)

    temp_dir = tempfile.mkdtemp()
    srt_path = os.path.join(temp_dir, "subs.srt")
    dubbed_audio_path_wav = os.path.join(temp_dir, "dubbed.wav")
    dubbed_audio_path_m4a = os.path.join(temp_dir, "dubbed.m4a")
    
    voice = VOICES.get(target_language, VOICES['en'])

    if mode in ["both", "voice"]:
        print_progress("processing", 50, "Đang tạo giọng lồng tiếng...")
    else:
        print_progress("processing", 50, "Đang chuẩn bị phụ đề...")
    
    segments_audio_data = []

    with open(srt_path, "w", encoding="utf-8") as srt_file:
        for i, seg_data in enumerate(segments_data_list):
            # TTS progress: from 50% to 75%
            progress = int(50 + (i / max(len(segments_data_list), 1)) * 25)
            if mode in ["both", "voice"]:
                print_progress("processing", progress, f"Đang lồng tiếng đoạn {i+1}/{len(segments_data_list)}...")
            
            start_str = format_time(seg_data["start"])
            end_str = format_time(seg_data["end"])
            translated_text = seg_data["translated"]
            
            srt_file.write(f"{i + 1}\n")
            srt_file.write(f"{start_str} --> {end_str}\n")
            srt_file.write(f"{translated_text}\n\n")
            
            if mode in ["both", "voice"]:
                temp_tts_mp3 = os.path.join(temp_dir, f"tts_{i}.mp3")
                temp_tts_wav = os.path.join(temp_dir, f"tts_{i}.wav")
                
                # Generate TTS with retry
                success = await generate_tts(translated_text, voice, temp_tts_mp3)
                
                if success and os.path.exists(temp_tts_mp3):
                    convert_mp3_to_wav(ffmpeg_exe, temp_tts_mp3, temp_tts_wav)
                    
                    if os.path.exists(temp_tts_wav):
                        segments_audio_data.append((seg_data["start"], temp_tts_wav))
                
    if mode in ["both", "voice"]:
        print_progress("processing", 75, "Đang căn chỉnh âm thanh khớp thời gian...")
        
        sample_rate = 44100
        total_duration = segments_data_list[-1]["end"] if segments_data_list else 0
        master_length = int((total_duration + 10) * sample_rate)
        master_audio = np.zeros(master_length, dtype=np.float32)

        for start_time, wav_path in segments_audio_data:
            try:
                with wave.open(wav_path, 'rb') as f:
                    frames = f.readframes(f.getnframes())
                    audio_data = np.frombuffer(frames, dtype=np.int16).astype(np.float32)
                
                start_sample = int(start_time * sample_rate)
                end_sample = start_sample + len(audio_data)
                
                if end_sample > master_length:
                    extension = np.zeros(end_sample - master_length, dtype=np.float32)
                    master_audio = np.concatenate((master_audio, extension))
                    master_length = end_sample
                
                master_audio[start_sample:end_sample] += audio_data
            except Exception as e:
                print(f"Error mixing {wav_path}: {e}", file=sys.stderr)

        # Clip and save mixed audio to WAV
        master_audio = np.clip(master_audio, -32768, 32767).astype(np.int16)
        with wave.open(dubbed_audio_path_wav, 'wb') as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(sample_rate)
            f.writeframes(master_audio.tobytes())
        
        # Convert WAV to AAC (m4a)
        concat_cmd = [
            ffmpeg_exe, "-y", "-i", dubbed_audio_path_wav,
            "-c:a", "aac", "-b:a", "192k",
            dubbed_audio_path_m4a
        ]
        subprocess.run(concat_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    print_progress("processing", 90, "Đang chèn ghép các thành phần và xuất video (có thể mất vài phút)...")
    
    escaped_srt_path = srt_path.replace("\\", "/").replace(":", "\\:")
    
    final_cmd = [
        ffmpeg_exe, "-y",
        "-i", video_path
    ]
    
    if mode in ["both", "voice"]:
        final_cmd.extend(["-i", dubbed_audio_path_m4a])
        final_cmd.extend(["-map", "0:v:0", "-map", "1:a:0"])
    else:
        final_cmd.extend(["-map", "0:v:0", "-map", "0:a:0?"])
        
    final_cmd.extend(["-c:v", "libx264"])
    
    if mode in ["both", "sub"]:
        final_cmd.extend(["-vf", f"subtitles='{escaped_srt_path}'"])
        
    final_cmd.extend([
        "-c:a", "copy" if mode == "sub" else "aac",
        output_path
    ])
    
    process = subprocess.Popen(final_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    stdout, stderr = process.communicate()
    
    if process.returncode != 0:
        print_progress("error", 90, f"Lỗi FFmpeg: {stderr}")
        sys.exit(1)
        
    print_progress("done", 100, "Hoàn tất lồng tiếng và chèn phụ đề!")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--language", default="vi")
    parser.add_argument("--mode", default="both", choices=["both", "sub", "voice"])
    parser.add_argument("--step", default="all", choices=["1", "2", "all"])
    parser.add_argument("--gemini-key", default="")
    
    args = parser.parse_args()
    
    asyncio.run(process_video(args.video, args.output, args.model, args.language, args.mode, args.step, args.gemini_key))

if __name__ == "__main__":
    main()
