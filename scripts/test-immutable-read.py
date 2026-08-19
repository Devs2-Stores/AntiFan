import os
import sqlite3

src = os.path.expanduser('~\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 2\\Network\\Cookies').replace('\\', '/')
uri = f"file:///{src}?mode=ro&immutable=1"
try:
    conn = sqlite3.connect(uri, uri=True)
    cur = conn.cursor()
    cur.execute("SELECT host_key, name FROM cookies WHERE host_key LIKE '%haravan%' OR host_key LIKE '%m-n-bakery%'")
    rows = cur.fetchall()
    print("Found cookies via immutable URI:", len(rows), rows[:5])
    conn.close()
except Exception as e:
    print("Error:", e)
