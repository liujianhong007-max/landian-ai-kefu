cmake_minimum_required(VERSION 3.16)
project(CdpEnabler VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# MinHook 库 (仅 x64，因为 PDD 是 x64 进程)
add_library(minhook STATIC
    minhook/src/buffer.c
    minhook/src/hook.c
    minhook/src/trampoline.c
    minhook/src/hde/hde64.c
)
target_include_directories(minhook PUBLIC minhook/include)
# MinHook 需要 /MT 静态链接
target_compile_options(minhook PRIVATE /MT /W3)

# 自研 DLL (x64 Release)
add_library(CdpEnabler SHARED
    src/dllmain.cpp
    src/hook_createprocess.cpp
)

target_include_directories(CdpEnabler PRIVATE src)
target_link_libraries(CdpEnabler PRIVATE minhook)

# 编译选项：/MT 静态链接 CRT，避免目标进程缺少 VC 运行时
target_compile_options(CdpEnabler PRIVATE /W4 /O2 /MT)
# /NODEFAULTLIB:libcmt 不需要，因为 /MT 已经选了静态 CRT

# 输出到 assets/inject/
set_target_properties(CdpEnabler PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../../assets/inject"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_SOURCE_DIR}/../../assets/inject"
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/build/lib"
)

message(STATUS "Output: ${CMAKE_SOURCE_DIR}/../../assets/inject/CdpEnabler.dll")
