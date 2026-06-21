# =============================================================================
# DRAFT — inspect before running. Durable interactive reports platform server.
#
# Fixes the LiveView interactivity bug from the prior attempt: instead of
# loading phoenix.js / phoenix_live_view.js from a CDN (version-drift → the
# LiveView channel silently never joins → phx-click dead), this VENDORS the
# deps' OWN priv/static JS and serves it SAME-ORIGIN via Plug.Static, so the
# client JS is always exactly the server's dep version. Validated approach
# (research wf_40b315e7): csrf meta + window.LiveView.LiveSocket + same-origin
# assets → channel joins → phx-click works.
#
# himalayas recon facts baked in:
#   - meshnet = NordVPN (NOT Tailscale); bind 0.0.0.0 → reachable at
#     100.100.39.44. No MagicDNS — peers use the raw 100.x IP.
#   - :4000 is the canonical Phoenix LiveView report surface.
#   - :8765 is taken by Logitech — do not use.
#   - pin elixir explicitly (two mise roots on the host).
#
# Run (manually, for inspection/testing):
#   mise x elixir@1.20.1-otp-29 -- elixir report-server.exs
# Durable: via the launchd plist draft (report-platform.plist).
#
# Multi-report: serves an index of every *.json under REPORTS_DIR, each
# rendered as an interactive LiveView at /r/<name>.
# =============================================================================
Mix.install([
  {:phoenix, "~> 1.8"},
  {:phoenix_live_view, "~> 1.0"},
  {:bandit, "~> 1.5"},
  {:jason, "~> 1.4"}
])

# REQUIRED: without this the LiveView socket transport 500s on encode
# (discovered during research validation).
Application.put_env(:phoenix, :json_library, Jason)

port = String.to_integer(System.get_env("ZQ_REPORT_PORT", "4000"))
reports_dir = System.get_env("ZQ_REPORTS_DIR", Path.expand("~/zq-report/reports"))
report_host = System.get_env("ZQ_REPORT_HOST", "100.100.39.44")
allowed_origins =
  case System.get_env("ZQ_ALLOWED_ORIGINS") do
    nil -> ["http://#{report_host}:#{port}", "http://localhost:#{port}", "http://127.0.0.1:#{port}"]
    raw -> raw |> String.split(",", trim: true) |> Enum.map(&String.trim/1)
  end

defmodule ZQ.Secrets do
  @moduledoc false

  defp create_secret_file!(path, secret) do
    case System.cmd("sh", ["-c", "umask 077; set -C; : > \"$1\"", "sh", path], stderr_to_stdout: true) do
      {_, 0} ->
        File.write!(path, secret, [:binary])
        File.chmod!(path, 0o600)

      {output, code} ->
        raise "could not create secret #{path} with private permissions (exit #{code}): #{String.trim(output)}"
    end
  end

  def get!(env, file_name, random_bytes) do
    case System.get_env(env) do
      value when is_binary(value) ->
        value = String.trim(value)
        if byte_size(value) >= random_bytes, do: value, else: raise "#{env} is too short"

      _ ->
        dir =
          System.get_env("ZQ_SECRET_DIR", Path.expand("~/zq-report/.secrets"))

        File.mkdir_p!(dir)
        File.chmod!(dir, 0o700)
        path = Path.join(dir, file_name)

        case File.read(path) do
          {:ok, value} ->
            value = String.trim(value)
            if byte_size(value) >= random_bytes, do: value, else: raise "secret #{path} is too short"

          {:error, :enoent} ->
            secret = :crypto.strong_rand_bytes(random_bytes) |> Base.url_encode64(padding: false)
            create_secret_file!(path, secret)
            secret

          {:error, reason} ->
            raise "could not read secret #{path}: #{inspect(reason)}"
        end
    end
  end
end

secret_key_base = ZQ.Secrets.get!("ZQ_SECRET_KEY_BASE", ".secret_key_base", 64)
live_view_signing_salt = ZQ.Secrets.get!("ZQ_LIVE_VIEW_SIGNING_SALT", ".live_view_signing_salt", 24)
session_signing_salt = ZQ.Secrets.get!("ZQ_SESSION_SIGNING_SALT", ".session_signing_salt", 24)
session_options = [store: :cookie, key: "_zq_key", signing_salt: session_signing_salt, same_site: "Lax"]

Application.put_env(:zq_report, ZQ.Endpoint,
  url: [host: report_host, port: port],
  adapter: Bandit.PhoenixAdapter,
  http: [ip: {0, 0, 0, 0}, port: port],
  server: true,
  secret_key_base: secret_key_base,
  live_view: [signing_salt: live_view_signing_salt],
  pubsub_server: ZQ.PubSub,
  render_errors: [formats: [html: ZQ.ErrorHTML]],
  check_origin: allowed_origins
)
Application.put_env(:zq_report, :session_options, session_options)

defmodule ZQ.ErrorHTML do
  def render(t, _), do: Phoenix.Controller.status_message_from_template(t)
end

defmodule ZQ.Reports do
  @moduledoc "Loads report JSON files from the reports dir."
  def dir, do: Application.get_env(:zq_report, :reports_dir)
  def list do
    case File.ls(dir()) do
      {:ok, fs} -> fs |> Enum.filter(&String.ends_with?(&1, ".json")) |> Enum.sort()
      _ -> []
    end
  end
  def load(name) do
    safe = Path.basename(name)  # path-traversal guard
    path = Path.join(dir(), safe)
    with true <- String.ends_with?(safe, ".json"),
         {:ok, raw} <- File.read(path),
         {:ok, data} <- Jason.decode(raw) do
      {:ok, data}
    else
      _ -> :error
    end
  end
end

defmodule ZQ.IndexLive do
  use Phoenix.LiveView, layout: {ZQ.Layout, :root}
  def mount(_p, _s, socket), do: {:ok, assign(socket, reports: ZQ.Reports.list())}
  def render(assigns) do
    ~H"""
    <div class="wrap">
      <h1>Reports</h1>
      <ul class="index">
        <li :for={r <- @reports}>
          <.link navigate={"/r/" <> Path.rootname(r)}>{Path.rootname(r)}</.link>
        </li>
        <li :if={@reports == []} class="empty">No reports in {ZQ.Reports.dir()}</li>
      </ul>
    </div>
    """
  end
end

defmodule ZQ.ReportLive do
  use Phoenix.LiveView, layout: {ZQ.Layout, :root}
  def mount(%{"name" => name}, _s, socket) do
    case ZQ.Reports.load(name <> ".json") do
      {:ok, data} -> {:ok, assign(socket, data: data, tab: "plan", open: MapSet.new([0]))}
      :error -> {:ok, socket |> put_flash(:error, "not found") |> assign(data: nil, tab: "plan", open: MapSet.new())}
    end
  end
  def handle_event("tab", %{"t" => t}, s), do: {:noreply, assign(s, tab: t)}
  def handle_event("toggle", %{"i" => i}, s) do
    case Integer.parse(i) do
      {idx, ""} when idx >= 0 ->
        open =
          if MapSet.member?(s.assigns.open, idx),
            do: MapSet.delete(s.assigns.open, idx),
            else: MapSet.put(s.assigns.open, idx)

        {:noreply, assign(s, open: open)}

      _ ->
        {:noreply, s}
    end
  end
  def render(%{data: nil} = assigns) do
    ~H"""
    <div class="wrap"><p>Report not found.</p></div>
    """
  end
  def render(assigns) do
    ~H"""
    <div class="wrap">
      <header>
        <h1>{@data["plan"]["summary"] && "Hardening Plan" || "Report"}</h1>
        <nav>
          <button class={@tab == "plan" && "on"} phx-click="tab" phx-value-t="plan">Plan</button>
          <button class={@tab == "findings" && "on"} phx-click="tab" phx-value-t="findings">Research</button>
        </nav>
      </header>
      <main :if={@tab == "plan"}>
        <ol class="phases">
          <li :for={{ph, i} <- Enum.with_index(@data["plan"]["sequencedPhases"] || @data["plan"]["phases"] || [])}
              class={MapSet.member?(@open, i) && "open"} phx-click="toggle" phx-value-i={i}>
            <div class="ph-head"><span class="ord">{ph["order"]}</span><span class="title">{ph["title"]}</span><span class="effort">{ph["effort"]}</span></div>
            <div :if={MapSet.member?(@open, i)} class="ph-body">
              <p>{ph["rationale"] || ph["detail"]}</p>
              <ul><li :for={p <- ph["proposals"] || []}>{p}</li></ul>
              <code>verify: {ph["verifyWith"] || ph["verify"]}</code>
            </div>
          </li>
        </ol>
      </main>
      <main :if={@tab == "findings"} class="findings">
        <section :for={f <- @data["findings"] || []}>
          <h3>{f["area"]}</h3>
          <div :for={p <- f["proposals"] || []} class={"prop risk-" <> (p["risk"] || "low")}>
            <strong>{p["title"]}</strong><span class="meta">{p["tier"]} · {p["effort"]} · {p["risk"]}</span>
          </div>
        </section>
      </main>
    </div>
    """
  end
end

defmodule ZQ.Layout do
  use Phoenix.Component
  def root(assigns) do
    ~H"""
    <!DOCTYPE html><html><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <meta name="csrf-token" content={Plug.CSRFProtection.get_csrf_token()}/>
    <title>ZQ Reports</title>
    <style>
      :root{color-scheme:dark} body{margin:0;font:15px/1.5 ui-monospace,Menlo,monospace;background:#0d1117;color:#c9d1d9}
      .wrap{max-width:980px;margin:0 auto;padding:2rem} h1{color:#58a6ff}
      nav button{background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:.4rem .9rem;cursor:pointer;border-radius:6px;margin-right:.5rem}
      nav button.on{border-color:#58a6ff;color:#58a6ff}
      .phases{list-style:none;padding:0} .phases li{border:1px solid #30363d;border-radius:8px;margin:.5rem 0;padding:.75rem 1rem;cursor:pointer}
      .phases li.open{border-color:#58a6ff} .ph-head{display:flex;gap:.75rem;align-items:center}
      .ord{background:#1f6feb;color:#fff;border-radius:50%;width:1.6rem;height:1.6rem;display:grid;place-items:center;font-size:.8rem}
      .title{flex:1;font-weight:600} .effort{color:#8b949e} .ph-body{margin-top:.6rem;padding-top:.6rem;border-top:1px solid #21262d}
      code{background:#161b22;padding:.2rem .4rem;border-radius:4px;color:#7ee787}
      .prop{border-left:3px solid #30363d;padding:.4rem .8rem;margin:.4rem 0} .prop.risk-low{border-color:#3fb950}
      .prop.risk-medium{border-color:#d29922} .prop.risk-high{border-color:#f85149} .meta{color:#8b949e;margin-left:.5rem;font-size:.85rem}
      .index{list-style:none;padding:0} .index li{padding:.4rem 0} a{color:#58a6ff}
    </style></head>
    <body>
      {@inner_content}
      <!-- SAME-ORIGIN vendored JS: served from the deps' priv/static (see endpoint
           Plug.Static below), so the client JS version always matches the server. -->
      <script src="/vendor/phoenix.min.js"></script>
      <script src="/vendor/phoenix_live_view.min.js"></script>
      <script>
        (function () {
          var csrf = document.querySelector("meta[name='csrf-token']").getAttribute("content");
          var liveSocket = new window.LiveView.LiveSocket("/live", window.Phoenix.Socket, {params: {_csrf_token: csrf}});
          liveSocket.connect();
          window.liveSocket = liveSocket;
        })();
      </script>
    </body></html>
    """
  end
end

defmodule ZQ.Router do
  use Phoenix.Router
  import Phoenix.LiveView.Router
  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end
  scope "/" do
    pipe_through :browser
    live "/", ZQ.IndexLive, :index
    live "/r/:name", ZQ.ReportLive, :show
  end
end

defmodule ZQ.Endpoint do
  use Phoenix.Endpoint, otp_app: :zq_report
  @session_options Application.fetch_env!(:zq_report, :session_options)
  socket "/live", Phoenix.LiveView.Socket, websocket: [connect_info: [session: @session_options]]
  # Vendor the deps' own JS same-origin (the interactivity fix):
  plug Plug.Static, at: "/vendor", from: {:phoenix, "priv/static"}, only: ~w(phoenix.min.js phoenix.min.js.map)
  plug Plug.Static, at: "/vendor", from: {:phoenix_live_view, "priv/static"},
       only: ~w(phoenix_live_view.min.js phoenix_live_view.min.js.map)
  plug Plug.Session, @session_options
  plug ZQ.Router
end

Application.put_env(:zq_report, :reports_dir, reports_dir)
File.mkdir_p!(reports_dir)
{:ok, _} = Supervisor.start_link([ZQ.Endpoint, {Phoenix.PubSub, name: ZQ.PubSub}], strategy: :one_for_one)
IO.puts("ZQ reports platform: http://100.100.39.44:#{port}  (reports: #{reports_dir})")
Process.sleep(:infinity)
