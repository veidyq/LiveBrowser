using System;
using System.Collections.Generic;
using System.Text.Json;

namespace LiveBrowser;

/// <summary>
/// Core layer: the typed wire between the shell page and the host.
///
/// SHAPE OF THE CONTRACT
///   shell -> host  one JSON object, always with a string "type" (see the
///                  table in MainForm's header comment).  A message that is
///                  not an object, or has no "type", is not ours and is
///                  dropped before any handler sees it — previously the
///                  dispatcher fell through with type = "" and logged noise.
///   host -> shell  anonymous objects serialised by PostWebMessageAsJson in
///                  MainForm.Push.  Left as IsAnonymous so the shapes stay
///                  written once, next to the code that sends them.
///
/// The message classes below give the fields names and kinds instead of a
/// bag of JsonElement lookups scattered through the dispatcher.  Every
/// property is read defensively: a missing / mistyped field takes the
/// documented default rather than throwing halfway through a handler.
/// </summary>
internal static class Ipc
{
    // ---------------------------------------------------------------- parse

    public enum ParseResult
    {
        Ok,
        // Not JSON at all, JSON null / array / number, or an object with no
        // string "type": the host must ignore it, not complain.
        NotOurs,
    }

    public static ParseResult Parse(string raw, out string type, out JsonElement root)
    {
        type = "";
        root = default;
        if (string.IsNullOrEmpty(raw)) return ParseResult.NotOurs;

        JsonDocument doc;
        try { doc = JsonDocument.Parse(raw); }
        catch (JsonException) { return ParseResult.NotOurs; }

        // The document owns the element until disposed; the element is only
        // valid while it lives, so keep the parsed tree reachable through a
        // pooled root element instead of returning a dangling clone.
        root = doc.RootElement.Clone();
        doc.Dispose();

        if (root.ValueKind != JsonValueKind.Object) return ParseResult.NotOurs;
        type = Str(root, "type", "");
        return type.Length == 0 ? ParseResult.NotOurs : ParseResult.Ok;
    }

    // ------------------------------------------------------------- readers

    public static string Str(JsonElement e, string name, string fallback = "")
        => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? fallback
            : fallback;

    public static double Num(JsonElement e, string name, double fallback = 0)
        => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            && v.TryGetDouble(out var d) ? d : fallback;

    public static int Int(JsonElement e, string name, int fallback = 0)
        => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            && v.TryGetInt32(out var i) ? i : fallback;

    public static bool Flag(JsonElement e, string name, bool fallback = false)
        => e.TryGetProperty(name, out var v)
            ? v.ValueKind == JsonValueKind.True || (v.ValueKind != JsonValueKind.False && fallback)
            : fallback;

    public static JsonElement Obj(JsonElement e, string name)
        => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : default;

    // ------------------------------------------------------------ messages

    /// <summary>
    /// One shell -> host message, already validated.  Handlers take this
    /// instead of the raw tree so every field has a name once.
    /// </summary>
    internal readonly struct Message
    {
        public readonly string Type;
        public readonly JsonElement Root;

        public Message(string type, JsonElement root) { Type = type; Root = root; }

        public string Str(string name, string fallback = "") => Ipc.Str(Root, name, fallback);
        public double Num(string name, double fallback = 0) => Ipc.Num(Root, name, fallback);
        public int Int(string name, int fallback = 0) => Ipc.Int(Root, name, fallback);
        public bool Flag(string name, bool fallback = false) => Ipc.Flag(Root, name, fallback);
        public JsonElement Obj(string name) => Ipc.Obj(Root, name);

        // {"type":"open","url":...,"label":...}
        public string Url => Str("url");
        public string Label => Str("label");
        public string Action => Str("action");
        public int Id => Int("id");
        public int Index => Int("index");

        // {"type":"theme","theme":<json string>}
        public string Theme => Str("theme");
    }

    // ------------------------------------------------------- host -> shell

    /// <summary>
    /// Payloads the host posts to the shell.  MainForm.Push serialises
    /// anonymous objects; these constants exist so the type names are
    /// defined once and the C# side cannot drift from shell/app.js.
    /// </summary>
    internal static class Out
    {
        public const string Tabs = "tabs";
        public const string Nav = "nav";
        public const string Progress = "progress";
        public const string Toast = "toast";
        public const string Menu = "menu";
        public const string Suggests = "suggests";
        public const string MenuPick = "menu-pick";
        public const string SuggestPick = "suggest-pick";
        public const string TranslateOffer = "translate-offer";
        public const string Download = "download";
        public const string Ready = "ready";
    }

    // ------------------------------------------------------- panel layer

    /// <summary>
    /// The dropdown layer (shell/dropdown.html) speaks its own small
    /// protocol; it is validated the same way.
    /// </summary>
    internal static class Panel
    {
        public const string Ready = "panel-ready";
        public const string Pick = "pick";
        public const string MenuPick = "menu-pick";
    }
}
