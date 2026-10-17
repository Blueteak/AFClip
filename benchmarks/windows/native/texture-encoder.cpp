// Trusted local benchmark helper. Shared D3D11 texture -> GPU BT.709 NV12 -> NVENC.
// Stdin is a serial command stream. Stdout contains one JSON reply per command.
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>
#include <iomanip>
#include <string>
#include <stdexcept>
#include <chrono>
#include "nvEncodeAPI.h"
using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
double ms(Clock::time_point t) { return std::chrono::duration<double, std::milli>(Clock::now() - t).count(); }
void hr(HRESULT value, const char* action) {
  if (FAILED(value)) { std::ostringstream s; s << action << " HRESULT 0x" << std::hex << unsigned(value); throw std::runtime_error(s.str()); }
}
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value) CloseHandle(value); }
};
struct Encoder {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11Device1> device1;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<ID3D11VideoDevice> video;
  ComPtr<ID3D11VideoContext> videoContext;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
  ComPtr<ID3D11VideoProcessor> processor;
  ComPtr<ID3D11Texture2D> nv12, pixel;
  ComPtr<ID3D11VideoProcessorOutputView> outputView;
  NV_ENCODE_API_FUNCTION_LIST api = { NV_ENCODE_API_FUNCTION_LIST_VER };
  void* session = nullptr;
  NV_ENC_REGISTERED_PTR resource = nullptr;
  NV_ENC_OUTPUT_PTR bitstream = nullptr;
  HMODULE library = nullptr;
  Handle parent;
  std::ofstream output;
  unsigned frames = 0;
  static constexpr unsigned width = 1920, height = 1080;
  void nv(NVENCSTATUS status, const char* action) {
    if (status != NV_ENC_SUCCESS) throw std::runtime_error(std::string(action) + " NVENC status " + std::to_string(status));
  }
  Encoder(DWORD parentPid) {
    parent.value = OpenProcess(PROCESS_DUP_HANDLE, FALSE, parentPid);
    if (!parent.value) throw std::runtime_error("Cannot open Electron process for handle duplication");
    ComPtr<IDXGIFactory1> factory; hr(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "DXGI factory");
    ComPtr<IDXGIAdapter1> adapter;
    for (unsigned i = 0;; ++i) {
      ComPtr<IDXGIAdapter1> candidate;
      if (factory->EnumAdapters1(i, &candidate) == DXGI_ERROR_NOT_FOUND) break;
      DXGI_ADAPTER_DESC1 desc; candidate->GetDesc1(&desc);
      if (desc.VendorId == 0x10de && !(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) { adapter = candidate; break; }
    }
    if (!adapter) throw std::runtime_error("NVIDIA D3D11 adapter is required for this NVENC experiment");
    hr(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
       nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context), "D3D11 device");
    hr(device.As(&device1), "D3D11.1 device"); hr(device.As(&video), "Video device"); hr(context.As(&videoContext), "Video context");
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width; desc.Height = height; desc.MipLevels = desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_NV12; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT; desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    hr(device->CreateTexture2D(&desc, nullptr, &nv12), "NV12 texture");
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content = {};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = content.OutputWidth = width; content.InputHeight = content.OutputHeight = height;
    content.InputFrameRate = content.OutputFrameRate = {30, 1}; content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    hr(video->CreateVideoProcessorEnumerator(&content, &enumerator), "Video processor enumeration");
    hr(video->CreateVideoProcessor(enumerator.Get(), 0, &processor), "Video processor");
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC view = {}; view.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    hr(video->CreateVideoProcessorOutputView(nv12.Get(), enumerator.Get(), &view, &outputView), "NV12 output view");
    // Explicit full-range RGB -> limited-range BT.709 conversion on the GPU.
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE rgb = {}; rgb.RGB_Range = 0; rgb.YCbCr_Matrix = 1; rgb.Nominal_Range = 2;
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE yuv = {}; yuv.YCbCr_Matrix = 1; yuv.Nominal_Range = 1;
    videoContext->VideoProcessorSetStreamColorSpace(processor.Get(), 0, &rgb);
    videoContext->VideoProcessorSetOutputColorSpace(processor.Get(), &yuv);
    videoContext->VideoProcessorSetStreamFrameFormat(processor.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    videoContext->VideoProcessorSetStreamAutoProcessingMode(processor.Get(), 0, FALSE);
    library = LoadLibraryExW(L"nvEncodeAPI64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!library) throw std::runtime_error("NVIDIA driver NVENC library unavailable");
    auto create = reinterpret_cast<NVENCSTATUS (NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*)>(GetProcAddress(library, "NvEncodeAPICreateInstance"));
    if (!create) throw std::runtime_error("NvEncodeAPICreateInstance unavailable");
    nv(create(&api), "NVENC API");
  }
  void start(const std::string& file) {
    if (session) throw std::runtime_error("An encode is already open");
    output.open(file, std::ios::binary); if (!output) throw std::runtime_error("Cannot open H264 output");
    frames = 0;
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open = { NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER };
    open.device = device.Get(); open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX; open.apiVersion = NVENCAPI_VERSION;
    nv(api.nvEncOpenEncodeSessionEx(&open, &session), "Open NVENC session");
    NV_ENC_PRESET_CONFIG preset = { NV_ENC_PRESET_CONFIG_VER }; preset.presetCfg.version = NV_ENC_CONFIG_VER;
    nv(api.nvEncGetEncodePresetConfigEx(session, NV_ENC_CODEC_H264_GUID, NV_ENC_PRESET_P4_GUID, NV_ENC_TUNING_INFO_HIGH_QUALITY, &preset), "P4 preset");
    auto& cfg = preset.presetCfg;
    cfg.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID; cfg.gopLength = 60; cfg.frameIntervalP = 1;
    cfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CONSTQP;
    cfg.rcParams.constQP.qpInterP = cfg.rcParams.constQP.qpInterB = cfg.rcParams.constQP.qpIntra = 16;
    cfg.rcParams.enableLookahead = 0;
    cfg.encodeCodecConfig.h264Config.idrPeriod = 60;
    auto& vui = cfg.encodeCodecConfig.h264Config.h264VUIParameters;
    vui.videoSignalTypePresentFlag = 1; vui.videoFormat = NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED; vui.videoFullRangeFlag = 0;
    vui.colourDescriptionPresentFlag = 1; vui.colourPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT709;
    vui.transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_BT709; vui.colourMatrix = NV_ENC_VUI_MATRIX_COEFFS_BT709;
    NV_ENC_INITIALIZE_PARAMS init = { NV_ENC_INITIALIZE_PARAMS_VER };
    init.encodeGUID = NV_ENC_CODEC_H264_GUID; init.presetGUID = NV_ENC_PRESET_P4_GUID;
    init.encodeWidth = init.darWidth = width; init.encodeHeight = init.darHeight = height;
    init.frameRateNum = 30; init.frameRateDen = 1; init.enablePTD = 1;
    init.tuningInfo = NV_ENC_TUNING_INFO_HIGH_QUALITY; init.encodeConfig = &cfg;
    nv(api.nvEncInitializeEncoder(session, &init), "Initialize NVENC");
    NV_ENC_REGISTER_RESOURCE reg = { NV_ENC_REGISTER_RESOURCE_VER };
    reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX; reg.resourceToRegister = nv12.Get();
    reg.width = width; reg.height = height; reg.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12; reg.bufferUsage = NV_ENC_INPUT_IMAGE;
    nv(api.nvEncRegisterResource(session, &reg), "Register NV12 texture"); resource = reg.registeredResource;
    NV_ENC_CREATE_BITSTREAM_BUFFER buffer = { NV_ENC_CREATE_BITSTREAM_BUFFER_VER };
    nv(api.nvEncCreateBitstreamBuffer(session, &buffer), "Bitstream buffer"); bitstream = buffer.bitstreamBuffer;
  }
  // Only one pixel comes back to CPU to reject stale paint events. Never read the full frame.
  unsigned token(ID3D11Texture2D* texture, DXGI_FORMAT format) {
    D3D11_TEXTURE2D_DESC desc = {}; if (pixel) pixel->GetDesc(&desc);
    if (!pixel || desc.Format != format) {
      pixel.Reset(); desc = {}; desc.Width = desc.Height = desc.MipLevels = desc.ArraySize = desc.SampleDesc.Count = 1;
      desc.Format = format; desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      hr(device->CreateTexture2D(&desc, nullptr, &pixel), "Readiness pixel");
    }
    D3D11_BOX box = { width - 4, height - 4, 0, width - 3, height - 3, 1 };
    context->CopySubresourceRegion(pixel.Get(), 0, 0, 0, 0, texture, 0, &box);
    D3D11_MAPPED_SUBRESOURCE mapped; hr(context->Map(pixel.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Read readiness pixel");
    auto p = static_cast<unsigned char*>(mapped.pData);
    unsigned value = format == DXGI_FORMAT_B8G8R8A8_UNORM ? p[2] | (p[1] << 8) | (p[0] << 16) : p[0] | (p[1] << 8) | (p[2] << 16);
    context->Unmap(pixel.Get(), 0); return value;
  }
  void frame(uintptr_t rawHandle, unsigned wanted) {
    if (!session) throw std::runtime_error("No encode is open");
    const auto startTime = Clock::now();
    Handle shared;
    if (!DuplicateHandle(parent.value, reinterpret_cast<HANDLE>(rawHandle), GetCurrentProcess(), &shared.value, 0, FALSE, DUPLICATE_SAME_ACCESS)) throw std::runtime_error("Duplicate shared handle failed");
    ComPtr<ID3D11Texture2D> texture;
    hr(device1->OpenSharedResource1(shared.value, IID_PPV_ARGS(&texture)), "Open shared texture on NVIDIA adapter");
    D3D11_TEXTURE2D_DESC desc; texture->GetDesc(&desc);
    if (desc.Width != width || desc.Height != height || (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM && desc.Format != DXGI_FORMAT_R8G8B8A8_UNORM)) throw std::runtime_error("Unsupported shared texture geometry/format");
    unsigned seen = token(texture.Get(), desc.Format);
    const double readyMs = ms(startTime);
    if (seen != wanted) { std::cout << "{\"accepted\":false,\"seen\":" << seen << "}" << std::endl; return; }
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC view = {}; view.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    ComPtr<ID3D11VideoProcessorInputView> input;
    hr(video->CreateVideoProcessorInputView(texture.Get(), enumerator.Get(), &view, &input), "RGB input view");
    D3D11_VIDEO_PROCESSOR_STREAM stream = {}; stream.Enable = TRUE; stream.pInputSurface = input.Get();
    hr(videoContext->VideoProcessorBlt(processor.Get(), outputView.Get(), frames, 1, &stream), "GPU RGB to NV12");
    NV_ENC_MAP_INPUT_RESOURCE map = { NV_ENC_MAP_INPUT_RESOURCE_VER }; map.registeredResource = resource;
    nv(api.nvEncMapInputResource(session, &map), "Map NVENC texture");
    NV_ENC_PIC_PARAMS pic = { NV_ENC_PIC_PARAMS_VER };
    pic.inputWidth = width; pic.inputHeight = height; pic.inputBuffer = map.mappedResource; pic.bufferFmt = map.mappedBufferFmt;
    pic.outputBitstream = bitstream; pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME; pic.inputTimeStamp = frames; pic.inputDuration = 1;
    nv(api.nvEncEncodePicture(session, &pic), "Encode texture");
    NV_ENC_LOCK_BITSTREAM lock = { NV_ENC_LOCK_BITSTREAM_VER }; lock.outputBitstream = bitstream;
    nv(api.nvEncLockBitstream(session, &lock), "Wait for encoded packet");
    output.write(static_cast<char*>(lock.bitstreamBufferPtr), lock.bitstreamSizeInBytes);
    const auto bytes = lock.bitstreamSizeInBytes;
    nv(api.nvEncUnlockBitstream(session, bitstream), "Unlock packet");
    nv(api.nvEncUnmapInputResource(session, map.mappedResource), "Unmap encoder input");
    if (!output) throw std::runtime_error("Write H264 output failed");
    ++frames;
    std::cout << "{\"accepted\":true,\"frame\":" << frames - 1 << ",\"readinessMs\":" << readyMs << ",\"nativeMs\":" << ms(startTime) << ",\"encodedBytes\":" << bytes << "}" << std::endl;
  }
  void close() {
    if (!session) return;
    // No B frames or lookahead: every submitted frame was drained before acknowledgment.
    NV_ENC_PIC_PARAMS eos = { NV_ENC_PIC_PARAMS_VER }; eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
    nv(api.nvEncEncodePicture(session, &eos), "Flush NVENC");
    output.close();
    if (bitstream) { api.nvEncDestroyBitstreamBuffer(session, bitstream); bitstream = nullptr; }
    if (resource) { api.nvEncUnregisterResource(session, resource); resource = nullptr; }
    api.nvEncDestroyEncoder(session); session = nullptr;
  }
  ~Encoder() { try { close(); } catch (...) {} if (library) FreeLibrary(library); }
};
int main(int argc, char** argv) {
  try {
    if (argc != 2) throw std::runtime_error("Usage: texture-encoder <parent PID>");
    Encoder encoder(static_cast<DWORD>(std::stoul(argv[1])));
    std::cout << "{\"ready\":true,\"encoder\":\"NVENC D3D11 / P4 QP16 / BT709 NV12\"}" << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
      std::istringstream command(line); std::string op; command >> op;
      if (op == "start") { std::string file; command >> std::quoted(file); encoder.start(file); std::cout << "{\"started\":true}" << std::endl; }
      else if (op == "frame") { uintptr_t handle; unsigned token; command >> std::hex >> handle >> std::dec >> token; if (!command) throw std::runtime_error("Invalid frame command"); encoder.frame(handle, token); }
      else if (op == "end") { encoder.close(); std::cout << "{\"frames\":" << encoder.frames << "}" << std::endl; }
      else throw std::runtime_error("Unknown helper command");
    }
  } catch (const std::exception& e) { std::cerr << e.what() << std::endl; return 1; }
}
