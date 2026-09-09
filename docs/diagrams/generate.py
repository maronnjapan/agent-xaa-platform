#!/usr/bin/env python3
"""構成図の .drawio と .svg / .png を、同一のレイアウト定義から生成する。

使い方:
    python3 docs/diagrams/generate.py

依存: cairosvg（PNG生成にのみ必要。未導入なら .drawio と .svg のみ出力する）
方針: 色は白黒。GCPサービスのみ公式アイコンを使う。テキストは最小限で、図の中は英語と識別子だけに
      する（日本語の説明は docs/diagrams/README.md に置く。CJKフォントの有無で図が壊れないため）。

出力は1つの .drawio（3ページ）と、ページごとの .svg / .png である。

    architecture.drawio            Architecture / STANDARD / FULL_ISOLATION の3ページ
    architecture.svg / .png        全体構成
    architecture-standard.svg / .png        Isolation Level = STANDARD の構成
    architecture-full-isolation.svg / .png  Isolation Level = FULL_ISOLATION の構成

矢印の約束（凡例としても図の中に描く）:
    実線は常設の呼び出しで、呼び出す側から呼び出される側へ向く。応答は描かない。
    破線は enable_google_bridge=true のときだけ通る呼び出しである。
    ✕ で終わる線は、IAMで拒否されていて到達しないことを示す。
呼び出しの向きの正本は docs/08-gcp-infrastructure.md §3 であり、ここはその図解である。
"""
import base64
import os
import xml.etree.ElementTree as ET

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# --- GCP公式アイコン（draw.io shape libraryのSVGをbase64で埋め込み） ---
ICONS = {
 "run": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnY9Imh0dHBzOi8vdmVjdGEuaW8vbmFubyIgd2lkdGg9IjM2NS40NjQ5OTY3NzA0MjQ5MyIgaGVpZ2h0PSIzNzkuMjIyOTk0NDYzNTc3OTUiIHZpZXdCb3g9IjAgMCA5Ni42OTU5OTkxNDU1MDc4MSAxMDAuMzM1OTk4NTM1MTU2MjUiPiYjeGE7PHN0eWxlIHR5cGU9InRleHQvY3NzIj4mI3hhOwkuc3Qwe2ZpbGw6IzQyODVmNDt9JiN4YTsJLnN0MXtmaWxsOiNhZWNiZmE7fSYjeGE7PC9zdHlsZT4mI3hhOwk8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMjkuNzk0IDEwMC4zMzZMNDYuOTIgNTAuMTY4aDQ5Ljc3NnpNMCA5OS42NzFsMTIuOTc2LTQ5LjUwMkgyOS4yMkwxNi44OTcgOTIuMDU0eiIvPiYjeGE7CTxwYXRoIGNsYXNzPSJzdDEiIGQ9Ik0yOS43OTQgMEw0Ni45MiA1MC4xNjhoNDkuNzc2ek0wIC42NjZsMTIuOTc2IDQ5LjUwMkgyOS4yMkwxNi44OTcgOC4yODN6Ii8+JiN4YTs8L3N2Zz4=",
 "sql": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnY9Imh0dHBzOi8vdmVjdGEuaW8vbmFubyIgd2lkdGg9IjE0LjY1OTk5OTg0NzQxMjExIiBoZWlnaHQ9IjIwIiB2aWV3Qm94PSIwIDAgMTQuNjU5OTk5ODQ3NDEyMTEgMjAiPiYjeGE7CTxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI+JiN4YTsJLnN0MHtmaWxsOiM0Mjg1ZjQ7fSYjeGE7CS5zdDF7ZmlsbDojNjY5ZGY2O30mI3hhOwkuc3Qye2ZpbGw6I2FlY2JmYTt9JiN4YTsJPC9zdHlsZT4mI3hhOwk8c3R5bGU+JiN4YTsJCS5Ee2ZpbGwtcnVsZTpldmVub2RkfSYjeGE7CTwvc3R5bGU+JiN4YTsJPHBhdGggZD0iTTcuMzMgMTUuMzV2LTMuMDFMMCA4LjQ0djMuMDF6bTAgNC42NXYtMy4wMUwwIDEzLjA5djMuMDF6IiBjbGFzcz0ic3QyIEQiLz4mI3hhOwk8cGF0aCBkPSJNMTQuNjYgOC40NGwtNy4zMyAzLjl2My4wMWw3LjMzLTMuOXptMCA0LjY1bC03LjMzIDMuOVYyMGw3LjMzLTMuOXoiIGNsYXNzPSJzdDEgRCIvPiYjeGE7CTxwYXRoIGQ9Ik03LjMzIDB2My4wMWw3LjMzIDMuOVYzLjl6IiBjbGFzcz0ic3QwIEQiLz4mI3hhOwk8cGF0aCBkPSJNMCA2LjkxbDcuMzMtMy45VjBMMCAzLjl6IiBjbGFzcz0iRCBzdDEiLz4mI3hhOwk8cGF0aCBkPSJNNy4zMyAxMC43OVY3Ljc3TDAgMy44N3YzLjAyeiIgY2xhc3M9IkQgc3QyIi8+JiN4YTsJPHBhdGggZD0iTTE0LjY2IDMuODdsLTcuMzMgMy45djMuMDJsNy4zMy0zLjl6IiBjbGFzcz0iRCBzdDEiLz4mI3hhOzwvc3ZnPg==",
 "firestore": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnY9Imh0dHBzOi8vdmVjdGEuaW8vbmFubyIgd2lkdGg9IjMyMy45MDU2MTAzOTg2NzUxNSIgaGVpZ2h0PSIzNzYuNDIyMjk0OTYzNjg0MDciIHZpZXdCb3g9Ii0wLjA5NzAwMDAwMjg2MTAyMjk1IDAuMjg3OTk5OTg3NjAyMjMzOSA4NS42OTk5OTY5NDgyNDIxOSA5OS41OTUwMDEyMjA3MDMxMiI+JiN4YTs8c3R5bGUgdHlwZT0idGV4dC9jc3MiPiYjeGE7CS5zdDB7ZmlsbDojYWVjYmZhO30mI3hhOwkuc3Qxe2ZpbGw6IzY2OWRmNjt9JiN4YTsJLnN0MntmaWxsOiM0Mjg1ZjQ7fSYjeGE7PC9zdHlsZT4mI3hhOwk8cGF0aCBjbGFzcz0ic3QwIiBkPSJNLS4wOTcgNzUuODE1VjU1Ljg3NGw0Mi44NS0yMC4xODN2MTkuMDd6bTAtMzUuNDAzVjIwLjQ3MUw0Mi43NTMuMjg4djE5LjA3eiIvPiYjeGE7CTxwYXRoIGNsYXNzPSJzdDEiIGQ9Ik04NS42MDMgNzUuODE1VjU1Ljg3NGwtNDIuODUtMjAuMTgzdjE5LjA3em0wLTM1LjQwM1YyMC40NzFMNDIuNzUzLjI4OHYxOS4wN3oiLz4mI3hhOwk8cGF0aCBjbGFzcz0ic3QyIiBkPSJNNDIuNzUzIDgwLjMxNGwxNi4yMTctNy41MjUgMjEuMDg0IDkuNzE3LTM3LjMwMSAxNy4zNzd6Ii8+JiN4YTs8L3N2Zz4=",
 "kms": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnY9Imh0dHBzOi8vdmVjdGEuaW8vbmFubyIgd2lkdGg9IjMxMC43NzU2MDY1NDM4NjAyNSIgaGVpZ2h0PSIzNzcuOTUzMDI4ODM1NTI1NDYiIHZpZXdCb3g9Ii0wLjE0MDAwMDAwMDU5NjA0NjQ1IC0wLjQ2NzAwMDAwNzYyOTM5NDUzIDgyLjIyNTk5NzkyNDgwNDY5IDEwMC4wMDAwMDc2MjkzOTQ1MyI+JiN4YTs8c3R5bGUgdHlwZT0idGV4dC9jc3MiPiYjeGE7CS5zdDB7ZmlsbDojNDI4NWY0O30mI3hhOwkuc3Qxe2ZpbGw6IzY2OWRmNjt9JiN4YTsJLnN0MntmaWxsOiNmZmY7fSYjeGE7PC9zdHlsZT4mI3hhOwk8cGF0aCBjbGFzcz0ic3QwIiBkPSJNNDAuOTczLS40NjdsNDEuMTEzIDE3LjQ5M3YyOS42NTRjMCAyNy40MTgtMjQuNjA4IDUwLjgzNi00MS4xMTMgNTIuODUzeiIvPiYjeGE7CTxwYXRoIGNsYXNzPSJzdDEiIGQ9Ik00MC45NzMtLjQ2N0wtLjE0IDE3LjAyNXYyOS42NTRjMCAyNy40MTggMjQuNjA4IDUwLjgzNiA0MS4xMTMgNTIuODUzeiIvPiYjeGE7CTxwYXRoIGNsYXNzPSJzdDIiIGQ9Ik00MS4yNTMgMTYuNjA1Yy05LjU4NCAwLTE3LjQ0NSA3Ljg2Mi0xNy40NDUgMTcuNDQ1IDAgOC4wODQgNS41OTQgMTQuOTQyIDEzLjA5NiAxNi44OTF2OS40ODhoLTkuODY5djguNzAxaDkuODY5djUuMzc3aC02LjMxNXY4LjcwMWg2LjMxNXYyLjE5N2g4LjcwMVY1MC45NDFDNTMuMTA2IDQ4Ljk5MiA1OC43IDQyLjEzNCA1OC43IDM0LjA1YzAtOS41ODQtNy44NjMtMTcuNDQ1LTE3LjQ0Ny0xNy40NDV6bTAgOC42OTlBOC42OCA4LjY4IDAgMCAxIDUwIDM0LjA1YTguNjggOC42OCAwIDAgMS04Ljc0OCA4Ljc0NiA4LjY4IDguNjggMCAwIDEtOC43NDYtOC43NDYgOC42OCA4LjY4IDAgMCAxIDguNzQ2LTguNzQ2eiIvPiYjeGE7PC9zdmc+",
 "bq": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnY9Imh0dHBzOi8vdmVjdGEuaW8vbmFubyIgd2lkdGg9IjIwLjAwMTA0NTIyNzA1MDc4IiBoZWlnaHQ9IjIwLjAwMTA0NTIyNzA1MDc4IiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIHZpZXdCb3g9IjAgMCAyMC4wMDEwNDUyMjcwNTA3OCAyMC4wMDEwNDUyMjcwNTA3OCI+JiN4YTsJPHN0eWxlIHR5cGU9InRleHQvY3NzIj4mI3hhOwkuc3Qwe2ZpbGw6I2FlY2JmYTt9JiN4YTsJLnN0MXtmaWxsOiM2NjlkZjY7fSYjeGE7CS5zdDJ7ZmlsbDojNDI4NWY0O30mI3hhOwk8L3N0eWxlPiYjeGE7CTxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik00LjczIDguODN2Mi42M2E0LjkxIDQuOTEgMCAwIDAgMS43MSAxLjc0VjguODN6Ii8+JiN4YTsJPHBhdGggY2xhc3M9InN0MSIgZD0iTTcuODkgNi40MXY3LjUzQTcuNjIgNy42MiAwIDAgMCA5IDE0YTggOCAwIDAgMCAxIDBWNi40MXoiLz4mI3hhOwk8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMTEuNjQgOS44NnYzLjI5YTUgNSAwIDAgMCAxLjctMS44MlY5Ljg2eiIvPiYjeGE7CTxwYXRoIGNsYXNzPSJzdDIiIGQ9Ik0xNS43NCAxNC4zMmwtMS40MiAxLjQyYS40Mi40MiAwIDAgMCAwIC42bDMuNTQgMy41NGEuNDIuNDIgMCAwIDAgLjU5IDBsMS40My0xLjQzYS40Mi40MiAwIDAgMCAwLS41OWwtMy41NC0zLjU0YS40Mi40MiAwIDAgMC0uNiAwIi8+JiN4YTsJPHBhdGggY2xhc3M9InN0MSIgZD0iTTkgMGE5IDkgMCAxIDAgMCAxOEE5IDkgMCAxIDAgOSAwbTAgMTUuNjlhNi42OCA2LjY4IDAgMCAxIC4wMDctMTMuMzYgNi42OCA2LjY4IDAgMCAxIDQuNzI3IDExLjQwM0E2LjY4IDYuNjggMCAwIDEgOSAxNS42OSIvPiYjeGE7PC9zdmc+",
 "logging": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnY9Imh0dHBzOi8vdmVjdGEuaW8vbmFubyIgd2lkdGg9IjIwIiBoZWlnaHQ9IjE5IiB2aWV3Qm94PSIwIDAgMjAgMTkiPiYjeGE7CTxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI+JiN4YTsJLnN0MHtmaWxsOiM0Mjg1ZjQ7fSYjeGE7CS5zdDF7ZmlsbDojNjY5ZGY2O30mI3hhOwkuc3Qye2ZpbGw6I2FlY2JmYTt9JiN4YTsJPC9zdHlsZT4mI3hhOwk8ZyBjbGFzcz0ic3QwIj4mI3hhOwkJPHBhdGggZD0iTTQgOWg0djJINHptLTIgN2g2djJIMnoiLz4mI3hhOwkJPHBhdGggZD0iTTQgNEgydjEyaDJ6Ii8+JiN4YTsJPC9nPiYjeGE7CTxwYXRoIGNsYXNzPSJzdDEiIGQ9Ik0yMCAxSDd2NGgxM3ptMCA3SDd2NGgxM3ptMCA3SDd2NGgxM3oiLz4mI3hhOwk8cGF0aCBjbGFzcz0ic3QyIiBkPSJNNiAwSDB2Nmg2eiIvPiYjeGE7PC9zdmc+",
 "pubsub": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnY9Imh0dHBzOi8vdmVjdGEuaW8vbmFubyIgd2lkdGg9IjE4LjMxOTk5OTY5NDgyNDIyIiBoZWlnaHQ9IjIwLjAwMDAwMTkwNzM0ODYzMyIgdmlld0JveD0iMCAwIDE4LjMxOTk5OTY5NDgyNDIyIDIwLjAwMDAwMTkwNzM0ODYzMyI+JiN4YTsJPHN0eWxlIHR5cGU9InRleHQvY3NzIj4mI3hhOwkuc3Qwe2ZpbGw6IzY2OWRmNjt9JiN4YTsJLnN0MXtmaWxsOiM0Mjg1ZjQ7fSYjeGE7CS5zdDJ7ZmlsbDojYWVjYmZhO30mI3hhOwk8L3N0eWxlPiYjeGE7CTxkZWZzPiYjeGE7CQk8ZmlsdGVyIGlkPSJBIiB4PSI0LjY0IiB5PSI0LjE5IiB3aWR0aD0iMTQuNzMiIGhlaWdodD0iMTIuNzYiIGZpbHRlclVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgY29sb3ItaW50ZXJwb2xhdGlvbi1maWx0ZXJzPSJzUkdCIj4mI3hhOwkJCTxmZUZsb29kIGZsb29kLWNvbG9yPSIjZmZmIi8+JiN4YTsJCQk8ZmVCbGVuZCBpbj0iU291cmNlR3JhcGhpYyIvPiYjeGE7CQk8L2ZpbHRlcj4mI3hhOwkJPG1hc2sgaWQ9IkIiIHg9IjQuNjQiIHk9IjQuMTkiIHdpZHRoPSIxNC43MyIgaGVpZ2h0PSIxMi43NiIgbWFza1VuaXRzPSJ1c2VyU3BhY2VPblVzZSI+JiN4YTsJCQk8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyLjIzIiByPSIzLjU4IiBmaWx0ZXI9InVybCgjQSkiLz4mI3hhOwkJPC9tYXNrPiYjeGE7CTwvZGVmcz4mI3hhOwk8ZyBjbGFzcz0ic3QwIj4mI3hhOwkJPGNpcmNsZSBjeD0iMTYuMTMiIGN5PSI2LjIxIiByPSIxLjcyIi8+JiN4YTsJCTxjaXJjbGUgY3g9IjIuMTkiIGN5PSI2LjIxIiByPSIxLjcyIi8+JiN4YTsJCTxjaXJjbGUgY3g9IjkuMTYiIGN5PSIxOC4yOCIgcj0iMS43MiIvPiYjeGE7CTwvZz4mI3hhOwk8ZyBtYXNrPSJ1cmwoI0IpIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMi44NCAtMikiPiYjeGE7CQk8cGF0aCB0cmFuc2Zvcm09Im1hdHJpeCguNSAtLjg3IC44NyAuNSAtNC41OSAyMC41MykiIGQ9Ik0xNC42OSAxMC4yMmgxLjU5djguMDRoLTEuNTl6IiBjbGFzcz0ic3QxIi8+JiN4YTsJCTxwYXRoIHRyYW5zZm9ybT0icm90YXRlKDMzMCA4LjUyMyAxNC4yNDQpIiBkPSJNNC40OSAxMy40NWg4LjA0djEuNTlINC40OXoiIGNsYXNzPSJzdDEiLz4mI3hhOwkJPHBhdGggZD0iTTExLjIgNC4xOWgxLjU5djguMDRIMTEuMnoiIGNsYXNzPSJzdDEiLz4mI3hhOwk8L2c+JiN4YTsJPGcgY2xhc3M9InN0MiI+JiN4YTsJCTxjaXJjbGUgY3g9IjkuMTYiIGN5PSIxMC4yMyIgcj0iMi43OCIvPiYjeGE7CQk8Y2lyY2xlIGN4PSIyLjE5IiBjeT0iMTQuMjUiIHI9IjIuMTkiLz4mI3hhOwkJPGNpcmNsZSBjeD0iMTYuMTMiIGN5PSIxNC4yNSIgcj0iMi4xOSIvPiYjeGE7CQk8Y2lyY2xlIGN4PSI5LjE2IiBjeT0iMi4xOSIgcj0iMi4xOSIvPiYjeGE7CTwvZz4mI3hhOzwvc3ZnPg==",
 "vertex": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnY9Imh0dHBzOi8vdmVjdGEuaW8vbmFubyIgd2lkdGg9IjIwIiBoZWlnaHQ9IjE3LjUiIGZpbGwtcnVsZT0iZXZlbm9kZCIgdmlld0JveD0iMCAwIDIwIDE3LjUiPiYjeGE7CTxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI+JiN4YTsJLnN0MHtmaWxsOiM0Mjg1ZjQ7fSYjeGE7CS5zdDF7ZmlsbDojNjY5ZGY2O30mI3hhOwk8L3N0eWxlPiYjeGE7CTxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik0xOC45MSAxMC42M0wyMCA4Ljc1IDE3LjgyIDVoLTMuMDdsLTEuMDYtMS44NkgxMi41VjEuODhoMS45NGwxLjA2IDEuODdoMS41OUwxNC45IDBoLTQuMjd2NWgxLjczbC43MyAxLjI1aC0yLjQ2djIuNWgyLjI2bDEuMDUtMS44N2gyLjgxbC43MiAxLjI1aC0yLjhMMTMuNjIgMTBoLTIuOTl2NC4zOGgzLjRsLS43MiAxLjI1aC0yLjY4djEuODdoNC4yN2wzLjI4LTUuNjJoLTIuMDlsLS43MyAxLjI1SDEyLjV2LTEuMjVoMi4xNGwuNzQtMS4yNXoiLz4mI3hhOwk8cGF0aCBjbGFzcz0ic3QxIiBkPSJNMS4wOSAxMC42M0wwIDguNzUgMi4xOCA1aDMuMDdsMS4wNi0xLjg2SDcuNVYxLjg4SDUuNTZMNC41IDMuNzVIMi45MUw1LjEgMGg0LjI4djVINy42NGwtLjczIDEuMjVoMi40N3YyLjVINy4xMUw2LjA2IDYuODhIMy4yNWwtLjcyIDEuMjVoMi44TDYuMzggMTBoM3Y0LjM4SDUuOTdsLjcyIDEuMjVoMi42OXYxLjg3SDUuMWwtMy4yOC01LjYyaDIuMDlsLjczIDEuMjVINy41di0xLjI1SDUuMzZsLS43NC0xLjI1eiIvPiYjeGE7PC9zdmc+",
 "scheduler": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnY9Imh0dHBzOi8vdmVjdGEuaW8vbmFubyIgd2lkdGg9IjM2MC4zMDM3NjY4NjA4MzYzIiBoZWlnaHQ9IjM3OC4wNTExNTgwNzc0MDg4IiB2aWV3Qm94PSItMC4wMDAxNjI0MjExNDM2MTM3NTU3IC0wLjAwMDEwMDAwNTk0OTIwNzExNTkyIDk1LjMzMDI2MTIzMDQ2ODc1IDEwMC4wMjYxMDAxNTg2OTE0Ij4mI3hhOzxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI+JiN4YTsJLnN0MHtmaWxsOiM0Mjg1ZjQ7fSYjeGE7CS5zdDF7ZmlsbDojYWVjYmZhO30mI3hhOwkuc3Qye2ZpbGw6IzY2OWRmNjt9JiN4YTs8L3N0eWxlPiYjeGE7CTxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik03OS45NzEgNzcuNzE1bC03LjM1OSA3LjQ4OCA4LjYzOSA4LjQ5IDcuMzU5LTcuNDg4em0tNjUuMDk2LjA2MWwtOC42NDEgOC40OTIgNy4zNjEgNy40ODggOC42MzktOC40OXoiLz4mI3hhOwk8cGF0aCBjbGFzcz0ic3QxIiBkPSJNNzkuNTUzLjIyMWE1LjI1IDUuMjUgMCAwIDAtMy42NiA4Ljk4NEw4Ni4zODkgMTkuNThhNS4yNSA1LjI1IDAgMCAwIDguOTQxLTMuNzY1IDUuMjUgNS4yNSAwIDAgMC0xLjU2LTMuNzA0TDgzLjI3NSAxLjczOEE1LjI1IDUuMjUgMCAwIDAgNzkuNTUzLjIyMXpNMTUuOTE2IDBhNS4yNSA1LjI1IDAgMCAwLTMuNzIzIDEuNTE2TDEuNjk5IDExLjg5MWE1LjI1IDUuMjUgMCAwIDAtLjA0MyA3LjQyNCA1LjI1IDUuMjUgMCAwIDAgNy40MjQuMDQzTDE5LjU3NiA4Ljk4MkE1LjI1IDUuMjUgMCAwIDAgMTUuOTE2IDB6Ii8+JiN4YTsJPHBhdGggY2xhc3M9InN0MCIgZD0iTTQ4LjEzOCAyNi4yNGMxMy4zNDcgMCAyNS40MzIgMTEuMTM2IDI1LjMxIDI2LjQ4MSAwIDE1LjExLTEyLjI2NyAyNS42NzMtMjUuMTg5IDI1LjY3My0xMS4xNDkgMC0xOC4zMTctNS4xNzEtMjEuOTYtMTAuNzM4bDIxLjgzOS0xNS4wOTd6Ii8+JiN4YTsJPHBhdGggY2xhc3M9InN0MiIgZD0iTTgxLjI1IDkzLjY5M2w0LjY2NCA0LjU4NmE1LjI1IDUuMjUgMCAxIDAgNy4zNjEtNy40OWwtNC42NjYtNC41ODR6TTYuMjM0IDg2LjI2OEwxLjU3IDkwLjg1MWE1LjI1IDUuMjUgMCAwIDAtLjA2NSA3LjQyNCA1LjI1IDUuMjUgMCAwIDAgNy40MjQuMDY0bDQuNjY2LTQuNTg0ek00Ny4zNzEgNS41NzhDMjEuMzQ5IDUuNTc4LjE0NiAyNi43NzkuMTQ2IDUyLjgwMXMyMS4yMDMgNDcuMjI1IDQ3LjIyNSA0Ny4yMjUgNDcuMjI1LTIxLjIwMyA0Ny4yMjUtNDcuMjI1UzczLjM5MyA1LjU3OCA0Ny4zNzEgNS41Nzh6bTAgMTBhMzcuMTUgMzcuMTUgMCAwIDEgMzcuMjI1IDM3LjIyM2MwIDIwLjYxNy0xNi42MDcgMzcuMjI1LTM3LjIyNSAzNy4yMjVTMTAuMTQ2IDczLjQxOCAxMC4xNDYgNTIuODAxYTM3LjE1IDM3LjE1IDAgMCAxIDM3LjIyNS0zNy4yMjN6Ii8+JiN4YTs8L3N2Zz4=",
}

# =====================================================================
# ページ定義
#
# ノード: (id, kind, label, x, y, w, h, icons)
#   kind: group / app / box / iconnode / actor / note
#   label の "|" は改行。app と box は2行目を小さく、note は1行目だけ太字にする。
# エッジ: (id, src, dst, label, flow, exit(rel), entry(rel), 中間点)
#   flow: call     常設の呼び出し（実線）
#         optional enable_google_bridge=true のときだけ通る呼び出し（破線）
#         blocked  IAMで拒否されていて到達しない（破線 + ✕）
# =====================================================================

LEGEND = ("Legend|"
          "Solid arrow: a call. It points from the caller to the callee - responses are not drawn.|"
          "Dashed arrow: a call that exists only when enable_google_bridge=true.|"
          "Dashed frame: the GCP Project, or a logical grouping inside it.|"
          "Call directions follow docs/08-gcp-infrastructure.md section 3.")

# --- ページ1: 全体構成 -------------------------------------------------
MAIN_NODES = [
    # 枠
    ("g_platform",  "group", "agent-xaa-platform (single GCP Project)", 180,  30, 1000, 800, ()),
    ("g_control",   "group", "Control Plane",         200,  70,  960, 120, ()),
    ("g_op",        "group", "Agent OP / same issuer as Human IdP", 200, 250,  350, 110, ()),
    ("g_data",      "group", "Data / Keys",           220, 570,  500, 110, ()),
    ("g_tel",       "group", "Telemetry",             240, 705,  760, 110, ()),
    ("g_google",    "group", "Google|only when enable_google_bridge=true", 1240, 250, 220, 130, ()),
    ("g_docs",      "group", "Document Resource",    1240, 420,  220, 110, ()),
    ("g_fin",       "group", "Finance Resource",     1240, 560,  220, 110, ()),
    # 外部
    ("user",  "actor",    "Human User",         55,  90,  30, 60, ()),
    ("hidp",  "box",      "Human IdP",          10, 280, 120, 50, ()),
    ("gas",   "box",      "Google OAuth AS",  1260, 285, 180, 34, ()),
    ("gapi",  "box",      "Google API",       1260, 330, 180, 34, ()),
    ("nas_docs",  "box",  "Resource AS",      1260, 448, 180, 30, ()),
    ("napi_docs", "box",  "Resource API",     1260, 488, 180, 30, ()),
    ("nas_fin",   "box",  "Resource AS",      1260, 588, 180, 30, ()),
    ("napi_fin",  "box",  "Resource API",     1260, 628, 180, 30, ()),
    # Control Plane
    ("auto",  "app", "Automation App",        220, 105, 200, 60, ("run",)),
    ("authz", "app", "Authorization Platform",450, 105, 200, 60, ("run",)),
    ("prov",  "app", "Agent Provisioner",     680, 105, 200, 60, ("run",)),
    ("life",  "app", "Lifecycle Manager",     910, 105, 200, 60, ("run", "scheduler")),
    # Identity / Runtime
    ("sop",   "app", "Shared Agent OP",       215, 285, 150, 60, ("run",)),
    ("dop",   "app", "Dedicated OP xN|created / destroyed at run time",
                                              380, 275, 155, 80, ("run",)),
    ("run",   "app", "Agent Runtime|Cloud Run Job / 1 Agent = 1 Execution",
                                              650, 275, 260, 80, ("run",)),
    ("gb",    "app", "Google Bridge",         960, 285, 180, 60, ("run",)),
    # Data / Keys
    ("fs",     "iconnode", "Firestore",       373, 610,  34, 40, ("firestore",)),
    ("kms",    "iconnode", "Cloud KMS",       484, 610,  32, 40, ("kms",)),
    ("secret", "box",      "Secret Manager",  580, 615, 110, 32, ()),
    ("vertex", "iconnode", "Vertex AI",       780, 612,  40, 36, ("vertex",)),
    # Telemetry. The audit dataset sits in the same Project; the separation is IAM.
    ("logging", "iconnode", "Cloud Logging",  260, 741,  40, 38, ("logging",)),
    ("pubsub",  "iconnode", "Pub/Sub",        420, 740,  36, 40, ("pubsub",)),
    ("sec",     "app",      "Security Detection", 560, 735, 200, 50, ("run",)),
    ("bq",      "iconnode", "BigQuery (security_audit)", 890, 740, 40, 40, ("bq",)),
    ("legend",  "note",     LEGEND,           180, 860, 700, 80, ()),
]

# Every arrow is a call, so the label names what the caller sends or asks for, never what
# comes back: the ID-JAG the OP mints and the subject_token the IdP returns travel against
# these arrows. The request / response pairs are in the sequence diagrams the docs carry.
MAIN_EDGES = [
    ("e_user_idp",  "user", "hidp", "login",             "call", (0.5, 1.0), (0.5, 0.0), []),
    ("e_user_auto", "user", "auto", "",                  "call", (1.0, 0.5), (0.0, 0.25), []),
    ("e_auto_hidp", "auto", "hidp", "OIDC",              "call", (0.0, 0.75), (1.0, 0.5), [(175, 150), (175, 305)]),
    ("e_auto_authz","auto", "authz","",                  "call", (1.0, 0.5), (0.0, 0.5), []),
    ("e_auto_prov", "auto", "prov", "create",            "call", (0.8, 0.0), (0.5, 0.0), [(380, 50), (780, 50)]),
    ("e_prov_op",   "prov", "g_op", "register / deploy", "call", (0.25, 1.0), (0.5, 0.0), [(730, 225), (375, 225)]),
    ("e_prov_run",  "prov", "run",  "start",             "call", (0.5, 1.0), (0.5, 0.0), []),
    ("e_prov_gb",   "prov", "gb",   "binding",           "optional", (0.75, 0.0), (0.944, 0.0), [(830, 85), (1130, 85)]),
    ("e_life_run",  "life", "run",  "revoke",            "call", (0.5, 1.0), (0.769, 0.0), [(1010, 245), (850, 245)]),
    ("e_run_op",    "run",  "g_op", "Token Exchange",    "call", (0.0, 0.5), (1.0, 0.59), []),
    ("e_op_hidp",   "g_op", "hidp", "Code Exchange / Refresh", "call", (0.0, 0.9), (0.333, 1.0),
                                                         [(160, 349), (160, 410), (50, 410)]),
    ("e_run_gb",    "run",  "gb",   "ID-JAG",            "optional", (1.0, 0.5), (0.0, 0.5), []),
    ("e_gb_gas",    "gb",   "gas",  "Refresh Token",     "optional", (1.0, 0.28), (0.0, 0.5), []),
    ("e_run_gapi",  "run",  "gapi", "Access Token",      "optional", (0.9, 1.0), (0.0, 0.5), [(884, 400), (1200, 400), (1200, 347)]),
    ("e_run_nas",   "run",  "nas_docs",  "ID-JAG",       "call", (0.33, 1.0), (0.0, 0.5), [(736, 463)]),
    ("e_run_napi",  "run",  "napi_docs", "Access Token", "call", (0.66, 1.0), (0.0, 0.5), [(822, 503)]),
    ("e_run_nasf",  "run",  "nas_fin",   "ID-JAG",       "call", (0.2, 1.0), (0.0, 0.5), [(702, 603)]),
    ("e_run_napif", "run",  "napi_fin",  "Access Token", "call", (0.8, 1.0), (0.0, 0.5), [(858, 643)]),
    ("e_op_kms",    "g_op", "kms",  "sign",              "call", (0.869, 1.0), (0.625, 0.0), []),
    ("e_log_pubsub","logging","pubsub", "",              "call", (1.0, 0.5), (0.0, 0.5), []),
    ("e_pubsub_sec","pubsub", "sec",    "",              "call", (1.0, 0.5), (0.0, 0.5), []),
    ("e_log_bq",    "logging","bq",  "Log Sink",         "call", (0.5, 1.0), (0.5, 1.0), [(280, 800), (910, 800)]),
]

MAIN_DASHED_GROUPS = {"g_google"}
MAIN_DASHED_NODES = {"gb"}

# --- ページ2: Isolation Level = STANDARD --------------------------------
STD_NOTE = (
    "STANDARD|"
    "Shared: the OP process, and the Runtime Job definition with its Service Account. "
    "Not shared: the execution or the identity - 1 Agent = 1 Execution at either level.|"
    "Cloud Run IAM binds sa-agent-runtime to shared-agent-op, so Layer 1 is identical for every "
    "STANDARD Agent. Layer 2, the Agent Client Credential, tells them apart.|"
    "Blast radius: a compromised Shared OP reaches the signing key, and the Registration and "
    "Refresh Token of every STANDARD Agent.|"
    "Dashed: created only when enable_google_bridge=true.")

STD_NODES = [
    ("g_cp",     "group", "Control Plane",                              60,  60, 520, 110, ()),
    ("prov",     "app",   "Agent Provisioner",                          80,  95, 220,  60, ("run",)),
    ("life",     "app",   "Lifecycle Manager",                         340,  95, 220,  60, ("run", "scheduler")),

    ("g_shared", "group", "Shared by every STANDARD Agent",             60, 250, 560, 210, ()),
    ("sop",      "app",   "Shared Agent OP|Cloud Run Service x1 / sa-shared-agent-op",
                                                                        85, 290, 320,  66, ("run",)),
    ("skms",     "iconnode", "ID-JAG signing key x1",                  490, 276,  32,  40, ("kms",)),
    ("sjob",     "app",   "Cloud Run Job agent-runtime|one definition / sa-agent-runtime",
                                                                        85, 380, 320,  60, ("run",)),

    ("g_per",    "group", "Created per Agent, at either Isolation Level", 700, 250, 420, 310, ()),
    ("reg",      "box",   "Agent Registration",                        730, 288, 360,  30, ()),
    ("cred",     "box",   "Agent Client Credential",                   730, 326, 360,  30, ()),
    ("conn",     "box",   "Human IdP Connection",                      730, 364, 360,  30, ()),
    ("xaa",      "box",   "XAA Static Config",                         730, 402, 360,  30, ()),
    ("bind",     "box",   "Bridge Agent Binding",                      730, 440, 360,  30, ()),
    ("exec",     "app",   "Execution|1 Agent = 1 Execution of the shared Job definition",
                                                                       730, 486, 360,  60, ("run",)),

    ("note",     "note",  STD_NOTE,                                     60, 600, 1060,  80, ()),
]

STD_EDGES = [
    ("s_prov_sop",  "prov", "sop",   "register",       "call", (0.3, 1.0), (0.19, 0.0), []),
    ("s_prov_per",  "prov", "g_per", "create",         "call", (0.9, 0.0), (0.5, 0.0), [(278, 45), (910, 45)]),
    ("s_life_sop",  "life", "sop",   "revoke",         "call", (0.5, 1.0), (0.828, 0.0), [(450, 210), (350, 210)]),
    ("s_sop_kms",   "sop",  "skms",  "sign",           "call", (1.0, 0.5), (0.0, 0.5), [(447, 323), (447, 305)]),
    ("s_exec_sop",  "exec", "sop",   "Token Exchange", "call", (0.0, 0.5), (1.0, 0.94), [(650, 516), (650, 352)]),
]

STD_DASHED_GROUPS = set()
STD_DASHED_NODES = {"bind"}

# --- ページ3: Isolation Level = FULL_ISOLATION ---------------------------
FULL_NOTE = (
    "FULL_ISOLATION|"
    "The left frame is created at run time by the Agent Provisioner and destroyed by Lifecycle "
    "Manager Cleanup. Terraform does not own it.|"
    "sa-agent-finance-001 may invoke dedicated-op-finance-001 and nothing else. sa-op-finance-001 "
    "may sign with the dedicated key only.|"
    "The dedicated ID-JAG key still sits in the shared issuer JWKS, so a leaked key forges the same "
    "range as a shared one.|"
    "What shrinks is how many Registrations and Refresh Tokens one breach reaches, not the forging "
    "power.|"
    "Dashed: created only when enable_google_bridge=true.")

FULL_NODES = [
    ("g_cp",    "group", "Control Plane",                                60,  60, 520, 110, ()),
    ("prov",    "app",   "Agent Provisioner",                            80,  95, 220,  60, ("run",)),
    ("life",    "app",   "Lifecycle Manager",                           340,  95, 220,  60, ("run", "scheduler")),

    ("g_ded",   "group", "Agent finance-001 only|created at run time, destroyed by Cleanup",
                                                                        60, 250, 620, 280, ()),
    ("dop",     "app",   "dedicated-op-finance-001|Cloud Run Service / sa-op-finance-001",
                                                                        90, 300, 330,  66, ("run",)),
    ("dkms",    "iconnode", "idjag key (dedicated)",                   520, 302,  32,  40, ("kms",)),
    ("djob",    "app",   "agent-runtime-finance-001|Cloud Run Job / sa-agent-finance-001",
                                                                        90, 420, 330,  66, ("run",)),
    ("dbind",   "box",   "Bridge Agent Binding",                       470, 428, 170,  30, ()),

    ("g_other", "group", "Shared plane, used by other Agents",         760, 250, 380, 280, ()),
    ("sop",     "app",   "Shared Agent OP|sa-shared-agent-op",         790, 300, 320,  66, ("run",)),
    ("srt",     "box",   "sa-agent-runtime (shared)",                  790, 420, 320,  30, ()),
    ("skeys",   "box",   "other Agents keys and connections",          790, 470, 320,  30, ()),

    ("note",    "note",  FULL_NOTE,                                     60, 570, 1080,  92, ()),
]

FULL_EDGES = [
    ("f_prov_dop",  "prov", "dop",   "deploy",          "call", (0.3, 1.0), (0.17, 0.0), []),
    ("f_prov_job",  "prov", "djob",  "create Job + SA", "call", (0.5, 1.0), (1.0, 0.5), [(190, 215), (450, 215), (450, 453)]),
    ("f_life_ded",  "life", "g_ded", "revoke / destroy","call", (0.6, 1.0), (0.665, 0.0), []),
    ("f_job_dop",   "djob", "dop",   "Token Exchange",  "call", (0.17, 0.0), (0.17, 1.0), []),
    ("f_dop_kms",   "dop",  "dkms",  "sign",            "call", (1.0, 0.5), (0.0, 0.5), [(470, 333), (470, 322)]),
    ("f_job_sop",   "djob", "g_other", "DENY (IAM)",    "blocked", (1.0, 0.75), (0.0, 0.296), [(720, 469.5), (720, 333)]),
]

FULL_DASHED_GROUPS = set()
FULL_DASHED_NODES = {"dbind"}

# --- ページの一覧 -------------------------------------------------------
# (drawio上のid, ページ名, 出力ファイル名の語幹, nodes, edges, 破線の枠, 破線の箱)
PAGES = [
    ("architecture",   "Architecture",    "architecture",
     MAIN_NODES, MAIN_EDGES, MAIN_DASHED_GROUPS, MAIN_DASHED_NODES),
    ("standard",       "STANDARD",        "architecture-standard",
     STD_NODES, STD_EDGES, STD_DASHED_GROUPS, STD_DASHED_NODES),
    ("full-isolation", "FULL_ISOLATION",  "architecture-full-isolation",
     FULL_NODES, FULL_EDGES, FULL_DASHED_GROUPS, FULL_DASHED_NODES),
]

FONT = "Helvetica, Arial, sans-serif"


def anchor(nodes, node_id, rel):
    _, _, _, x, y, w, h, _ = nodes[node_id]
    return (x + rel[0] * w, y + rel[1] * h)


def route(nodes, edge):
    _, src, dst, _, _, ex, en, mid = edge
    return [anchor(nodes, src, ex)] + [tuple(p) for p in mid] + [anchor(nodes, dst, en)]


def note_lines(label):
    """note の1行目は見出し、残りが本文である。"""
    head, *rest = label.split("|")
    return head, rest


# =====================================================================
# draw.io 出力
# =====================================================================
S_GROUP = ("rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#000000;dashed=1;"
           "verticalAlign=top;align=left;spacingLeft=6;spacingTop=2;fontStyle=1;fontColor=#000000;fontSize=12;")
S_BOX = "rounded=0;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#000000;fontColor=#000000;fontSize=12;"
S_APP = S_BOX + "spacingLeft=14;"
S_NOTE = ("rounded=0;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#000000;align=left;"
          "verticalAlign=top;spacingLeft=8;spacingTop=2;fontColor=#000000;fontSize=10;")
S_ACTOR = ("shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;"
           "strokeColor=#000000;fillColor=#FFFFFF;fontColor=#000000;fontSize=11;")
S_EDGE = ("edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;"
          "strokeColor=#000000;fontColor=#000000;fontSize=10;")
# 呼び出しの種類ごとの線。blocked は矢じりの代わりに ✕ を置き、到達しないことを示す。
S_FLOW = {
    "call":     "endArrow=block;endFill=1;",
    "optional": "endArrow=block;endFill=1;dashed=1;",
    "blocked":  "endArrow=cross;endFill=0;dashed=1;",
}


def icon_style(key):
    return ("editableCssRules=.*;html=1;shape=image;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;"
            "verticalAlign=top;aspect=fixed;imageAspect=0;fontSize=10;fontColor=#000000;"
            f"image=data:image/svg+xml,{ICONS[key]};")


def emit_page(root, nodes, edges, dashed_groups, dashed_nodes):
    def vertex(vid, value, style, x, y, w, h):
        c = ET.SubElement(root, "mxCell", id=vid, value=value, style=style, vertex="1", parent="1")
        ET.SubElement(c, "mxGeometry", x=str(x), y=str(y), width=str(w), height=str(h),
                      **{"as": "geometry"})

    def two_line(label):
        return (label.replace("|", '<br><font style="font-size:10px">') +
                ("</font>" if "|" in label else ""))

    for nid, kind, label, x, y, w, h, icons in nodes:
        if kind == "group":
            style = S_GROUP + ("dashPattern=1 3;" if nid in dashed_groups else "")
            vertex(nid, label.replace("|", "&#10;"), style, x, y, w, h)
        elif kind == "actor":
            vertex(nid, label, S_ACTOR, x, y, w, h)
        elif kind == "box":
            style = S_BOX + ("fontSize=10;" if nid == "secret" else "")
            style += "dashed=1;" if nid in dashed_nodes else ""
            vertex(nid, two_line(label), style, x, y, w, h)
        elif kind == "iconnode":
            vertex(nid, label, icon_style(icons[0]), x, y, w, h)
        elif kind == "note":
            head, rest = note_lines(label)
            vertex(nid, "<b>" + head + "</b><br>" + "<br>".join(rest), S_NOTE, x, y, w, h)
        elif kind == "app":
            style = S_APP + ("dashed=1;" if nid in dashed_nodes else "")
            vertex(nid, two_line(label), style, x, y, w, h)
            ix = x + 6
            for k in icons:
                vertex(f"{nid}_icon_{k}", "", icon_style(k), ix, y + 6, 18, 18)
                ix += 22

    for eid, src, dst, label, flow, ex, en, mid in edges:
        style = S_EDGE + S_FLOW[flow]
        style += f"exitX={ex[0]};exitY={ex[1]};exitDx=0;exitDy=0;"
        style += f"entryX={en[0]};entryY={en[1]};entryDx=0;entryDy=0;"
        c = ET.SubElement(root, "mxCell", id=eid, value=label, style=style, edge="1",
                          parent="1", source=src, target=dst)
        g = ET.SubElement(c, "mxGeometry", relative="1", **{"as": "geometry"})
        if mid:
            arr = ET.SubElement(g, "Array", **{"as": "points"})
            for px, py in mid:
                ET.SubElement(arr, "mxPoint", x=str(px), y=str(py))


def emit_drawio(path):
    mxfile = ET.Element("mxfile", host="Electron", version="24.7.17", type="device")
    for page_id, page_name, _, nodes, edges, dashed_groups, dashed_nodes in PAGES:
        diagram = ET.SubElement(mxfile, "diagram", id=page_id, name=page_name)
        model = ET.SubElement(diagram, "mxGraphModel", dx="1400", dy="900", grid="1", gridSize="10",
                              guides="1", tooltips="1", connect="1", arrows="1", fold="1", page="1",
                              pageScale="1", pageWidth="1654", pageHeight="1169", math="0", shadow="0")
        root = ET.SubElement(model, "root")
        ET.SubElement(root, "mxCell", id="0")
        ET.SubElement(root, "mxCell", id="1", parent="0")
        emit_page(root, nodes, edges, dashed_groups, dashed_nodes)
    tree = ET.ElementTree(mxfile)
    ET.indent(tree, space="  ")
    tree.write(path, encoding="utf-8", xml_declaration=False)


# =====================================================================
# SVG 出力（PNG化用）
# =====================================================================
MARGIN = 20
# iconnode と actor はラベルを箱の下に置くため、その分だけ下端を広げる。
LABEL_DROP = {"iconnode": 16, "actor": 18}


def bounds(nodes, edges):
    xs, ys = [], []
    for _, kind, _, x, y, w, h, _ in nodes:
        xs += [x, x + w]
        ys += [y, y + h + LABEL_DROP.get(kind, 0)]
    index = {n[0]: n for n in nodes}
    for edge in edges:
        for px, py in route(index, edge):
            xs.append(px)
            ys.append(py)
    return (min(xs) - MARGIN, min(ys) - MARGIN, max(xs) + MARGIN, max(ys) + MARGIN)


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def text(x, y, s, size=12, anchor_="middle", bold=False):
    weight = ' font-weight="bold"' if bold else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT}" font-size="{size}"'
            f' text-anchor="{anchor_}" fill="#000000"{weight}>{esc(s)}</text>')


def emit_svg(path, nodes, edges, dashed_groups, dashed_nodes):
    index = {n[0]: n for n in nodes}
    minx, miny, maxx, maxy = bounds(nodes, edges)
    width, height = maxx - minx, maxy - miny
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
         f'width="{width:g}" height="{height:g}" viewBox="{minx:g} {miny:g} {width:g} {height:g}">',
         f'<rect x="{minx:g}" y="{miny:g}" width="{width:g}" height="{height:g}" fill="#ffffff"/>',
         '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" '
         'markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" '
         'fill="#000000"/></marker></defs>']

    def icon(key, x, y, w, h):
        return (f'<image x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="xMidYMid meet" '
                f'xlink:href="data:image/svg+xml;base64,{ICONS[key]}"/>')

    # 枠（背面）
    for nid, kind, label, x, y, w, h, _ in nodes:
        if kind != "group":
            continue
        pattern = "2 3" if nid in dashed_groups else "6 4"
        o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="none" stroke="#000000" '
                 f'stroke-dasharray="{pattern}"/>')
        head, _, note = label.partition("|")
        o.append(text(x + 6, y + 15, head, 12, "start", bold=True))
        if note:
            o.append(text(x + 6, y + 28, note, 9, "start"))

    # エッジ（ノードの下）
    for edge in edges:
        eid, src, dst, label, flow, ex, en, mid = edge
        pts = route(index, edge)
        cross = None
        if flow == "blocked":
            # 到達しないことを示す ✕ は、枠線の上に重ならないよう線の手前で止めて描く。
            (x1, y1), (x2, y2) = pts[-2], pts[-1]
            dx, dy = x2 - x1, y2 - y1
            length = (dx * dx + dy * dy) ** 0.5 or 1.0
            cross = (x2 - dx / length * 16, y2 - dy / length * 16)
            pts = pts[:-1] + [cross]
        d = " ".join(("M" if i == 0 else "L") + f" {px:.1f} {py:.1f}" for i, (px, py) in enumerate(pts))
        dash = ' stroke-dasharray="6 4"' if flow != "call" else ""
        marker = '' if cross else ' marker-end="url(#arrow)"'
        o.append(f'<path d="{d}" fill="none" stroke="#000000" stroke-width="1.2"{dash}{marker}/>')
        if cross:
            cx, cy = cross
            o.append(f'<path d="M {cx - 7:.1f} {cy - 7:.1f} L {cx + 7:.1f} {cy + 7:.1f} '
                     f'M {cx + 7:.1f} {cy - 7:.1f} L {cx - 7:.1f} {cy + 7:.1f}" fill="none" '
                     f'stroke="#000000" stroke-width="2.2"/>')
        if label:
            # 最長セグメントの中点にラベルを置く
            best, blen = None, -1
            for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
                seg = abs(x2 - x1) + abs(y2 - y1)
                if seg > blen:
                    blen, best = seg, ((x1 + x2) / 2, (y1 + y2) / 2)
            lx, ly = best
            tw = len(label) * 5.4 + 6
            o.append(f'<rect x="{lx - tw / 2:.1f}" y="{ly - 8:.1f}" width="{tw:.1f}" height="13" '
                     f'fill="#ffffff"/>')
            o.append(text(lx, ly + 2, label, 10))

    # ノード
    for nid, kind, label, x, y, w, h, icons in nodes:
        if kind == "group":
            continue
        if kind == "actor":
            cx, top = x + w / 2, y
            o.append(f'<g fill="none" stroke="#000000" stroke-width="1.4">'
                     f'<circle cx="{cx}" cy="{top + 8}" r="7" fill="#ffffff"/>'
                     f'<path d="M {cx} {top + 15} L {cx} {top + 38} M {cx - 12} {top + 24} '
                     f'L {cx + 12} {top + 24} M {cx} {top + 38} L {cx - 11} {top + 55} '
                     f'M {cx} {top + 38} L {cx + 11} {top + 55}"/></g>')
            o.append(text(cx, y + h + 12, label, 11))
        elif kind == "iconnode":
            o.append(icon(icons[0], x, y, w, h))
            o.append(text(x + w / 2, y + h + 11, label, 10))
        elif kind == "note":
            head, rest = note_lines(label)
            o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#ffffff" stroke="#000000"/>')
            o.append(text(x + 8, y + 16, head, 10, "start", bold=True))
            for i, line in enumerate(rest):
                o.append(text(x + 8, y + 30 + i * 13, line, 10, "start"))
        elif kind in ("box", "app"):
            dash = ' stroke-dasharray="4 3"' if nid in dashed_nodes else ""
            o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#ffffff" '
                     f'stroke="#000000"{dash}/>')
            ix = x + 6
            for k in icons:
                o.append(icon(k, ix, y + 6, 18, 18))
                ix += 22
            indent = 14 if kind == "app" else 0
            cx = x + indent + (w - indent) / 2
            size = 10 if nid == "secret" else 12
            lines = label.split("|")
            if len(lines) == 1:
                o.append(text(cx, y + h / 2 + size * 0.35, lines[0], size))
            else:
                o.append(text(cx, y + h / 2 - 2, lines[0], size))
                o.append(text(cx, y + h / 2 + 14, lines[1], 10))

    o.append("</svg>")
    svg = "\n".join(o)
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg)
    return svg


def main():
    drawio_path = os.path.join(OUT_DIR, "architecture.drawio")
    emit_drawio(drawio_path)
    print("wrote", drawio_path)
    try:
        import cairosvg
    except ImportError:
        cairosvg = None
        print("cairosvg が無いため PNG はスキップした")
    for _, _, stem, nodes, edges, dashed_groups, dashed_nodes in PAGES:
        svg_path = os.path.join(OUT_DIR, f"{stem}.svg")
        svg = emit_svg(svg_path, nodes, edges, dashed_groups, dashed_nodes)
        print("wrote", svg_path)
        if cairosvg is None:
            continue
        png_path = os.path.join(OUT_DIR, f"{stem}.png")
        cairosvg.svg2png(bytestring=svg.encode("utf-8"), write_to=png_path,
                         scale=2, background_color="#ffffff")
        print("wrote", png_path)


if __name__ == "__main__":
    main()
