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

async def process_video(video_path, output_path, model_size, target_language, mode):
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    
    if not os.path.exists(video_path):
        print_progress("error", 0, f"Không tìm thấy file: {video_path}")
        sys.exit(1)

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
        # Transcribe progress: from 10% to 50%
        if info.duration > 0:
            transcribe_prog = int(10 + (segment.end / info.duration) * 40)
            transcribe_prog = min(50, transcribe_prog)
            print_progress("processing", transcribe_prog, f"Đang nhận dạng giọng nói: {format_time(segment.end)}")

    temp_dir = tempfile.mkdtemp()
    srt_path = os.path.join(temp_dir, "subs.srt")
    dubbed_audio_path_wav = os.path.join(temp_dir, "dubbed.wav")
    dubbed_audio_path_m4a = os.path.join(temp_dir, "dubbed.m4a")
    
    voice = VOICES.get(target_language, VOICES['en'])

    if mode in ["both", "voice"]:
        print_progress("processing", 50, "Đang dịch và tạo giọng lồng tiếng...")
    else:
        print_progress("processing", 50, "Đang dịch và tạo phụ đề...")
    
    segments_data = []

    with open(srt_path, "w", encoding="utf-8") as srt_file:
        for i, segment in enumerate(segments):
            # Translate/TTS progress: from 50% to 80%
            progress = int(50 + (i / max(len(segments), 1)) * 30)
            if mode in ["both", "voice"]:
                print_progress("processing", progress, f"Đang lồng tiếng đoạn {i+1}/{len(segments)}...")
            else:
                print_progress("processing", progress, f"Đang tạo phụ đề đoạn {i+1}/{len(segments)}...")
            
            translated_text = translate_text(segment.text, source_language, target_language)
            
            start_str = format_time(segment.start)
            end_str = format_time(segment.end)
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
                        segments_data.append((segment.start, temp_tts_wav))
                
    if mode in ["both", "voice"]:
        print_progress("processing", 80, "Đang căn chỉnh âm thanh khớp thời gian...")
        
        sample_rate = 44100
        total_duration = segments[-1].end if segments else 0
        master_length = int((total_duration + 10) * sample_rate)
        master_audio = np.zeros(master_length, dtype=np.float32)

        for start_time, wav_path in segments_data:
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
    
    args = parser.parse_args()
    
    asyncio.run(process_video(args.video, args.output, args.model, args.language, args.mode))

if __name__ == "__main__":
    main()
