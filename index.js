import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import http from "http";

import { decodeUlaw, encodeUlaw } from "@wasm-audio-decoders/ulaw";
import Resampler from "wav-resampler";

dotenv.config();

// ----------------------------------------------------
//  OPENAI REALTIME CONNECTION
// ----------------------------------------------------
function connectToOpenAI() {
  const openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openAiWs.on("open", () => {
    console.log("🧠 Connected to OpenAI Realtime");

    openAiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: "You are a friendly restaurant AI assistant.",
          modalities: ["audio"],
          voice: "alloy",
        },
      })
    );
  });

  openAiWs.on("close", () => {
    console.log("⭕ OpenAI WebSocket closed");
  });

  openAiWs.on("error", (err) => {
    console.error("❌ OpenAI WebSocket error:", err);
  });

  return openAiWs;
}

// ----------------------------------------------------
//  EXPRESS APP
// ----------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Restaurant AI Voice Agent - Server Running on Render");
});

// ----------------------------------------------------
//  CREATE HTTP + WEBSOCKET SERVER
// ----------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ----------------------------------------------------
//  HANDLE TWILIO MEDIA STREAM CONNECTION
// ----------------------------------------------------
wss.on("connection", (ws) => {
  console.log("🔌 Twilio media stream connected");

  // Create OpenAI session for this call
  const openAiWs = connectToOpenAI();

  // ----------------------------
  //  OPENAI → TWILIO (AI SPEAKS)
  // ----------------------------
  openAiWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "response.audio.delta") {
      // PCM from OpenAI
      const pcmBuffer = Buffer.from(msg.delta, "base64");

      // Convert PCM → Float32
      const pcmFloat = new Float32Array(pcmBuffer.length / 2);
      for (let i = 0; i < pcmFloat.length; i++) {
        pcmFloat[i] = pcmBuffer.readInt16LE(i * 2) / 0x7fff;
      }

      // Resample 24k → 8k for Twilio
      const pcm8k = Resampler.resample(pcmFloat, 24000, 8000);

      // Encode mulaw
      const mulawOut = encodeUlaw(pcm8k);

      // Send audio back to Twilio
      ws.send(
        JSON.stringify({
          event: "media",
          media: {
            payload: Buffer.from(mulawOut).toString("base64"),
          },
        })
      );
    }
  });

  // ----------------------------
  //  TWILIO → OPENAI (CALLER SPEAKS)
  // ----------------------------
  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      console.log("🟢 Media stream started:", data.streamSid);
    }

    if (data.event === "media") {
      // 1. Decode Twilio mulaw → PCM float32
      const mulawBytes = Buffer.from(data.media.payload, "base64");
      const pcmFloat = decodeUlaw(mulawBytes);

      // 2. Resample from 8k → 24k for OpenAI
      const pcm24k = Resampler.resample(pcmFloat, 8000, 24000);

      // 3. Convert float32 → int16
      const pcmInt16 = Buffer.alloc(pcm24k.length * 2);
      for (let i = 0; i < pcm24k.length; i++) {
        const s = Math.max(-1, Math.min(1, pcm24k[i]));
        pcmInt16.writeInt16LE(s * 0x7fff, i * 2);
      }

      // 4. Send audio to OpenAI
      openAiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcmInt16.toString("base64"),
        })
      );

      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
    }

    if (data.event === "stop") {
      console.log("🔴 Media stream stopped:", data.streamSid);
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WS connection closed");
  });
});

// ----------------------------------------------------
//  TWILIO VOICE WEBHOOK
// ----------------------------------------------------
app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const connect = twiml.connect();
  connect.stream({
    url: "wss://restaurant-voice-agent-v2.onrender.com/twilio-media-stream",
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ----------------------------------------------------
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Server listening on port", port);
});
