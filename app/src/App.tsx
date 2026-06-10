import { useState, useEffect, useRef } from 'react'
import { Upload, FileVideo, Settings, Play, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react'

// Define the IPC types to avoid TS errors
declare global {
  interface Window {
    require: any;
  }
}

// Lấy ipcRenderer an toàn
const ipcRenderer = window.require ? window.require('electron').ipcRenderer : null;

function App() {
  const [machineId, setMachineId] = useState<string>('')
  const [isTrial, setIsTrial] = useState(true)
  const [trialDaysLeft, setTrialDaysLeft] = useState(3)
  const [licenseKey, setLicenseKey] = useState('')
  const [statusMsg, setStatusMsg] = useState('')

  // Translation Workspace State
  const [videoPath, setVideoPath] = useState<string | null>(null)
  const [modelSize, setModelSize] = useState('tiny')
  const [language, setLanguage] = useState('vi')
  const [outputType, setOutputType] = useState('both')
  const [isProcessing, setIsProcessing] = useState(false)
  const [progressData, setProgressData] = useState<{status: string, progress: number, message: string} | null>(null)
  const [outputResult, setOutputResult] = useState<string | null>(null)

  useEffect(() => {
    if (ipcRenderer) {
      ipcRenderer.invoke('get-machine-id').then((id: string) => {
        setMachineId(id)
      })

      // Listen to AI Progress
      ipcRenderer.on('ai-progress', (_event: any, data: any) => {
        setProgressData(data)
        if (data.status === 'done' || data.status === 'error') {
          setIsProcessing(false)
        }
      })
    } else {
      setMachineId('browser-mock-id')
    }
  }, [])

  const handleActivate = () => {
    if (!licenseKey) {
      setStatusMsg('Vui lòng nhập License Key!')
      return
    }
    setStatusMsg('Đang kiểm tra Key trên máy chủ...')
    setTimeout(() => {
      if (licenseKey === '12345') {
        setIsTrial(false)
        setStatusMsg('')
      } else {
        setStatusMsg('Key không hợp lệ hoặc đã được sử dụng.')
      }
    }, 1000)
  }

  const handleSelectVideo = async () => {
    try {
      if (!ipcRenderer) {
        alert("Lỗi: Không tìm thấy ipcRenderer. Vui lòng chạy ứng dụng qua Electron.");
        return;
      }
      const path = await ipcRenderer.invoke('select-video-file')
      if (path) {
        setVideoPath(path)
        setProgressData(null)
        setOutputResult(null)
      }
    } catch (e) {
      alert("Lỗi mở hộp thoại chọn file: " + String(e));
    }
  }

  const startTranslation = async () => {
    if (!videoPath || !ipcRenderer) return
    
    setIsProcessing(true)
    setProgressData({ status: 'init', progress: 0, message: 'Đang chuẩn bị...' })
    setOutputResult(null)

    // Generate output temp path
    const outputPath = videoPath + '.temp.mp4'

    try {
      const result = await ipcRenderer.invoke('run-ai-engine', videoPath, outputPath, modelSize, language, outputType)
      setOutputResult(outputPath)
      setIsProcessing(false) // Đảm bảo tắt loading khi xong
    } catch (error) {
      setProgressData({ status: 'error', progress: 0, message: String(error) })
      setIsProcessing(false)
    }
  }

  const handleSaveVideo = async () => {
    if (!outputResult || !ipcRenderer) return
    const savedPath = await ipcRenderer.invoke('save-video-file', outputResult)
    if (savedPath) {
      alert(`Tuyệt vời! Video lồng tiếng đã được lưu tại:\n${savedPath}`)
    }
  }

  // --- Main App View (Workspace) ---
  if (!isTrial && licenseKey) {
    return (
      <div className="flex min-h-screen bg-slate-900 text-slate-100 font-sans">
        {/* Sidebar */}
        <div className="w-80 glass border-r border-white/5 flex flex-col p-6 shadow-xl z-10">
          <div className="flex items-center space-x-3 mb-10">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg">
              <Play className="w-5 h-5 text-white ml-1" />
            </div>
            <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400">
              SubVideo
            </h1>
          </div>

          <div className="space-y-6 flex-1">
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center">
                  <Settings className="w-4 h-4 mr-2" /> Cấu hình AI
                </h3>
                <label className="block text-sm text-slate-300 mb-2">Độ chính xác (Model Size)</label>
                <select 
                  className="w-full bg-slate-950/50 border border-slate-700/50 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                  value={modelSize}
                  onChange={(e) => setModelSize(e.target.value)}
                  disabled={isProcessing}
                >
                  <option value="tiny">Tiny (Nhanh nhất, độ chuẩn thấp)</option>
                  <option value="base">Base (Cân bằng tốc độ)</option>
                  <option value="small">Small (Chuẩn xác, hơi chậm)</option>
                  <option value="medium">Medium (Rất chuẩn, chậm)</option>
                </select>
                <p className="text-xs text-slate-500 mt-2">Hệ thống sẽ tự động dùng GPU nếu máy bạn có hỗ trợ CUDA.</p>
              </div>

              <div>
                <label className="block text-sm text-slate-300 mb-2 mt-4">Chế độ xuất (Output Mode)</label>
                <select 
                  className="w-full bg-slate-950/50 border border-slate-700/50 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                  value={outputType}
                  onChange={(e) => setOutputType(e.target.value)}
                  disabled={isProcessing}
                >
                  <option value="both">Phụ đề & Lồng tiếng (Đầy đủ)</option>
                  <option value="sub">Chỉ tạo Phụ đề (Nhanh, nhẹ)</option>
                  <option value="voice">Chỉ Lồng tiếng (Tắt phụ đề)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-slate-300 mb-2 mt-4">Ngôn ngữ cần dịch</label>
                <select 
                  className="w-full bg-slate-950/50 border border-slate-700/50 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  disabled={isProcessing}
                >
                  <option value="vi">Tiếng Việt (Vietnamese)</option>
                  <option value="en">Tiếng Anh (English)</option>
                  <option value="zh">Tiếng Trung (Chinese)</option>
                  <option value="ja">Tiếng Nhật (Japanese)</option>
                  <option value="ko">Tiếng Hàn (Korean)</option>
                </select>
              </div>
            </div>

            <div className="pt-6 border-t border-slate-800">
              <button 
                onClick={startTranslation}
                disabled={!videoPath || isProcessing}
                className="w-full relative group disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg blur opacity-50 group-hover:opacity-100 transition duration-200"></div>
                <div className="relative flex items-center justify-center bg-slate-900 rounded-lg px-4 py-3 border border-white/10">
                  {isProcessing ? (
                    <><Loader2 className="w-5 h-5 mr-2 animate-spin text-blue-400" /> Đang xử lý...</>
                  ) : (
                    <><CheckCircle className="w-5 h-5 mr-2 text-emerald-400" /> Bắt đầu Dịch & Tạo Phụ đề</>
                  )}
                </div>
              </button>
            </div>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col relative overflow-hidden bg-slate-950/50">
          <div className="absolute top-[-20%] left-[20%] w-[60%] h-[60%] bg-blue-500/10 rounded-full blur-[120px] pointer-events-none"></div>
          
          <div className="flex-1 p-10 flex flex-col items-center justify-center relative z-10">
            {!videoPath ? (
              <div 
                onClick={handleSelectVideo}
                className="glass w-full max-w-2xl aspect-video rounded-2xl border-2 border-dashed border-slate-600 hover:border-blue-500 transition-colors cursor-pointer flex flex-col items-center justify-center text-slate-400 hover:text-blue-400 hover:bg-blue-500/5 group"
              >
                <div className="p-4 rounded-full bg-slate-800/50 group-hover:bg-blue-500/10 mb-4 transition-colors">
                  <Upload className="w-8 h-8" />
                </div>
                <p className="text-lg font-medium">Nhấn để chọn Video từ máy tính</p>
                <p className="text-sm text-slate-500 mt-1">Hỗ trợ .mp4, .mkv, .avi</p>
              </div>
            ) : (
              <div className="w-full max-w-4xl space-y-6">
                <div className="glass p-4 rounded-2xl flex items-center justify-between border border-white/5">
                  <div className="flex items-center space-x-4 overflow-hidden">
                    <div className="p-3 bg-blue-500/20 text-blue-400 rounded-xl">
                      <FileVideo className="w-6 h-6" />
                    </div>
                    <div className="truncate">
                      <p className="font-medium text-white truncate">{videoPath.split('\\').pop() || videoPath.split('/').pop()}</p>
                      <p className="text-xs text-slate-500 truncate">{videoPath}</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => { setVideoPath(null); setProgressData(null); setOutputResult(null); }}
                    className="text-sm text-slate-400 hover:text-red-400 px-4 py-2"
                    disabled={isProcessing}
                  >
                    Đổi file khác
                  </button>
                </div>

                {!outputResult && (
                  <div className="w-full aspect-video bg-slate-900 rounded-2xl flex items-center justify-center shadow-2xl border border-white/10 relative">
                    <p className="text-slate-500 flex flex-col items-center">
                      <Play className="w-12 h-12 mb-2 opacity-50" />
                      <span>Video đã được chọn sẵn sàng để phân tích</span>
                    </p>
                  </div>
                )}

                {/* Progress UI */}
                {progressData && (
                  <div className="glass p-6 rounded-2xl border border-white/5 space-y-4">
                    <div className="flex justify-between items-end">
                      <div>
                        <h4 className="text-sm font-medium text-white flex items-center">
                          {progressData.status === 'error' ? <AlertTriangle className="w-4 h-4 mr-2 text-red-500" /> : <Loader2 className={`w-4 h-4 mr-2 text-blue-400 ${isProcessing ? 'animate-spin' : ''}`} />}
                          {progressData.status === 'error' ? 'Lỗi xử lý' : progressData.status === 'done' ? 'Hoàn tất!' : 'Tiến trình Dịch AI'}
                        </h4>
                        <p className={`text-xs mt-1 ${progressData.status === 'error' ? 'text-red-400' : 'text-slate-400'}`}>
                          {progressData.message}
                        </p>
                      </div>
                      <span className="text-2xl font-bold text-blue-400">{progressData.progress}%</span>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                      <div 
                        className={`h-full rounded-full transition-all duration-500 ${progressData.status === 'error' ? 'bg-red-500' : progressData.status === 'done' ? 'bg-emerald-500' : 'bg-blue-500'}`} 
                        style={{ width: `${progressData.progress}%` }}
                      ></div>
                    </div>
                  </div>
                )}

                {/* Review Video UI */}
                {outputResult && !isProcessing && (
                  <div className="glass p-6 rounded-2xl border border-blue-500/30 space-y-4 animate-in fade-in zoom-in duration-500">
                    <div className="flex items-center space-x-3 text-blue-400 mb-2">
                      <Play className="w-6 h-6" />
                      <h3 className="text-lg font-bold">Bản xem trước (Review)</h3>
                    </div>
                    
                    <div className="w-full aspect-video bg-black rounded-xl overflow-hidden shadow-xl border border-white/10">
                      <video 
                        src={`file://${outputResult.replace(/\\/g, '/')}`} 
                        controls 
                        autoPlay
                        className="w-full h-full object-contain"
                      />
                    </div>
                    
                    <div className="flex space-x-4 pt-4">
                      <button 
                        onClick={handleSaveVideo}
                        className="flex-1 bg-gradient-to-r from-blue-600 to-emerald-600 hover:from-blue-500 hover:to-emerald-500 text-white font-bold py-3 px-4 rounded-lg transition-all shadow-lg shadow-blue-500/25 flex items-center justify-center"
                      >
                        <Upload className="w-5 h-5 mr-2" /> Lưu Video vào máy (Download)
                      </button>
                      <button 
                        onClick={() => { setOutputResult(null); setProgressData(null); }}
                        className="px-6 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium py-3 rounded-lg transition-all border border-slate-700"
                      >
                        Làm lại
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // --- Trial & License View (unchanged from before) ---
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-slate-100 p-6 relative overflow-hidden">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/20 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-600/20 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="glass p-10 rounded-3xl w-full max-w-lg z-10 shadow-2xl relative border border-white/10">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-extrabold mb-2 bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500">
            SubVideo AI
          </h1>
          <p className="text-slate-400">Công cụ tự động làm phụ đề & lồng tiếng bằng AI</p>
        </div>

        <div className="bg-slate-800/50 rounded-xl p-6 mb-8 border border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-slate-300 font-medium">Trạng thái:</span>
            <span className="text-emerald-400 font-bold bg-emerald-400/10 px-3 py-1 rounded-full text-sm">
              Dùng thử (Trial)
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-300 font-medium">Thời gian còn lại:</span>
            <span className="text-white font-bold">{trialDaysLeft} ngày</span>
          </div>
          <div className="mt-4 pt-4 border-t border-slate-700">
            <span className="text-slate-400 text-xs">Machine ID:</span>
            <code className="block text-xs bg-slate-900 p-2 rounded mt-1 text-slate-500 break-all">
              {machineId || 'Đang lấy...'}
            </code>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Mã kích hoạt (License Key)</label>
            <input 
              type="text" 
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
              placeholder="Nhập Key của bạn vào đây..."
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
            />
          </div>
          
          <button 
            onClick={handleActivate}
            className="w-full bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-bold py-3 px-4 rounded-lg transition-all transform hover:scale-[1.02] shadow-lg shadow-blue-500/25"
          >
            Kích Hoạt Ngay
          </button>
          
          {statusMsg && (
            <p className="text-center text-sm font-medium text-amber-400 mt-2">
              {statusMsg}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
