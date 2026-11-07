# Run with Chrome's remote debugging enabled on localhost:42429.
import base64
import json
import os
import socket
import struct
import time
import urllib.request
from urllib.parse import quote, urlparse
from pathlib import Path


request = urllib.request.Request(
    "http://127.0.0.1:42429/json/new?" + quote(
        os.environ.get("LOOPER_TEST_URL", (Path(__file__).resolve().parent.parent / "index.html").as_uri()),
        safe=":/",
    ),
    method="PUT",
)
target = json.load(urllib.request.urlopen(request))
ws_url = urlparse(target["webSocketDebuggerUrl"])
sock = socket.create_connection((ws_url.hostname, ws_url.port), timeout=30)
sock.sendall(
    (
        f"GET {ws_url.path} HTTP/1.1\r\n"
        f"Host: {ws_url.netloc}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    ).encode()
)
response = b""
while b"\r\n\r\n" not in response:
    response += sock.recv(1)
assert b" 101 " in response, response


def receive(size):
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise RuntimeError("Browser debugging connection closed")
        data += chunk
    return data


def send(payload):
    data = json.dumps(payload).encode()
    header = bytearray([0x81])
    if len(data) < 126:
        header.append(0x80 | len(data))
    elif len(data) < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", len(data)))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", len(data)))
    mask = os.urandom(4)
    sock.sendall(header + mask + bytes(byte ^ mask[i % 4] for i, byte in enumerate(data)))


def recv_message():
    first, second = receive(2)
    length = second & 127
    if length == 126:
        length = struct.unpack("!H", receive(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", receive(8))[0]
    mask = receive(4) if second & 0x80 else None
    data = receive(length)
    if mask:
        data = bytes(byte ^ mask[i % 4] for i, byte in enumerate(data))
    if first & 0x0F != 1:
        raise RuntimeError(f"Unexpected WebSocket frame: {first}")
    return json.loads(data)


command_id = 0


def command(method, params=None):
    global command_id
    command_id += 1
    send({"id": command_id, "method": method, "params": params or {}})
    while True:
        result = recv_message()
        if result.get("id") == command_id:
            if "error" in result:
                raise RuntimeError(result["error"])
            return result["result"]


def evaluate(expression):
    result = command("Runtime.evaluate", {"expression": expression, "returnByValue": True})
    if "exceptionDetails" in result:
        raise RuntimeError(result["exceptionDetails"])
    return result["result"].get("value")


def wait_for(expression):
    for _ in range(200):
        if evaluate(expression):
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out: {expression}")


try:
    wait_for("document.readyState === 'complete' && typeof sampleState !== 'undefined'")
    evaluate("""(() => {
      window.fetch = async url => {
        const data = String(url).endsWith('index.json')
          ? {kits: [{id: 'test', name: 'Test Kit', manifest: 'test/kit.json'},
                    {id: 'second', name: 'Second Kit', manifest: 'second/kit.json'}]}
          : {id: String(url).includes('/second/') ? 'second' : 'test',
             samples: Array.from({length: 28}, (_, i) => ({
               type: i < 20 ? 'Claps' : 'Type ' + i,
               name: 'Sample ' + i, url: 'sample.m4a'
             }))};
        return new Response(JSON.stringify(data), {status: 200});
      };
      openSampleManager(0, 0);
    })()""")
    wait_for("sampleState.kits?.[0]?.samples?.length === 28")

    for width, height in [(320, 568), (375, 667), (390, 844), (430, 932),
                          (500, 800), (501, 800), (520, 800), (521, 800), (1024, 768)]:
        command("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": width <= 500
        })
        result = evaluate("""(() => {
          const panel = document.querySelector('#sampleManager');
          const names = ['.sample-columns', '.sample-manager-footer', '#sampleKits button',
            '#sampleTypes button', '#sampleList button', '#sampleUse', '#sampleManagerClose',
            '#sampleBrowseFiles'];
          const rect = el => {
            const r = el.getBoundingClientRect();
            return {left: r.left, right: r.right, height: r.height,
              scrollWidth: el.scrollWidth, clientWidth: el.clientWidth};
          };
          return {panel: rect(panel), viewport: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            boxes: Object.fromEntries(names.map(name => [name, rect(panel.querySelector(name))])),
            typeScroll: rect(document.querySelector('#sampleTypes'))};
        })()""")
        assert result["panel"]["scrollWidth"] <= result["panel"]["clientWidth"] + 1, (width, result)
        assert result["boxes"][".sample-columns"]["scrollWidth"] <= result["boxes"][".sample-columns"]["clientWidth"] + 1, (width, result)
        assert result["documentWidth"] <= result["viewport"] + 1, (width, result)
        for name, box in result["boxes"].items():
            assert box["left"] >= result["panel"]["left"] - 1, (width, name, result)
            assert box["right"] <= result["panel"]["right"] + 1, (width, name, result)
            if width <= 520 and (name.endswith("button") or name in
                                 ("#sampleUse", "#sampleManagerClose", "#sampleBrowseFiles")):
                assert box["height"] >= 44, (width, name, result)
        if width <= 520:
            assert result["typeScroll"]["scrollWidth"] > result["typeScroll"]["clientWidth"], (width, result)

    command("Emulation.setDeviceMetricsOverride", {
        "width": 375, "height": 667, "deviceScaleFactor": 1, "mobile": True
    })
    assert evaluate("""(() => {
      const column = document.querySelector('.sample-column:last-child');
      return column.scrollHeight > column.clientHeight;
    })()""")
    evaluate("""(() => {
      ensureCtx();
      sampleState.kits[0].samples[19].buffer = ctx.createBuffer(1, 1000, 44100);
      const button = document.querySelector('#sampleList').lastElementChild;
      button.scrollIntoView({block: 'nearest'});
      button.click();
    })()""")
    wait_for("sampleState.selected?.name === 'Sample 19'")
    evaluate("""(() => {
      const types = document.querySelector('#sampleTypes');
      types.scrollLeft = types.scrollWidth;
      types.lastElementChild.click();
    })()""")
    assert evaluate("sampleState.type") == "Type 27"
    evaluate("""(() => {
      sampleState.kits[0].samples[27].buffer = ctx.createBuffer(1, 1000, 44100);
      document.querySelector('#sampleList button').click();
      document.querySelector('#sampleUse').click();
    })()""")
    wait_for("!!pads[0].buffer")
    assert evaluate("pads[0].name") == "Sample 27"
    assert evaluate("document.querySelector('#sampleManager').hidden")
    print("Sample panel fits phone and desktop widths; scrolling and selection work")
finally:
    sock.close()
    urllib.request.urlopen(f"http://127.0.0.1:42429/json/close/{target['id']}").read()
