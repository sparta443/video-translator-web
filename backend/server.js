const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL;
const allowedOrigins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    FRONTEND_URL,
].filter(Boolean);

const corsOptions = {
    origin(origin, callback) {
        // Allow requests without an Origin header (health checks, curl, etc.)
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error(`CORS blocked origin: ${origin}`));
    },
    methods: ["GET", "POST"],
};

app.use(cors(corsOptions));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
    cors: corsOptions,
});

const DEEPL_API_KEY = process.env.DEEPL_API_KEY;

async function translateText(text, sourceLanguage) {
    if (!DEEPL_API_KEY) {
        throw new Error("DEEPL_API_KEY is missing. Add it to backend/.env");
    }

    const sourceLang = sourceLanguage === "es" ? "ES" : "EN";
    const targetLang = sourceLanguage === "es" ? "EN" : "ES";

    const response = await axios.post(
        "https://api-free.deepl.com/v2/translate",
        new URLSearchParams({
            text,
            source_lang: sourceLang,
            target_lang: targetLang,
        }),
        {
            headers: {
                Authorization: `DeepL-Auth-Key ${DEEPL_API_KEY}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        }
    );

    const translation = response.data?.translations?.[0]?.text;

    if (!translation) {
        throw new Error("DeepL returned no translated text.");
    }

    return {
        translatedText: translation,
        targetLanguage: sourceLanguage === "es" ? "en" : "es",
    };
}

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", (roomId) => {
        const cleanRoomId = String(roomId || "").trim();
        if (!cleanRoomId) return;

        socket.join(cleanRoomId);

        const users = io.sockets.adapter.rooms.get(cleanRoomId);
        console.log("User joined room:", socket.id, cleanRoomId);
        console.log("Users in room:", users ? [...users] : []);

        socket.to(cleanRoomId).emit("user-joined", socket.id);
    });

    socket.on("offer", ({ roomId, offer }) => {
        socket.to(roomId).emit("offer", offer);
    });

    socket.on("answer", ({ roomId, answer }) => {
        socket.to(roomId).emit("answer", answer);
    });

    socket.on("ice-candidate", ({ roomId, candidate }) => {
        socket.to(roomId).emit("ice-candidate", candidate);
    });

    socket.on("chat-message", async ({ roomId, message, sourceLanguage }) => {
        try {
            const cleanRoomId = String(roomId || "").trim();
            const cleanText = String(message?.original || "").trim();

            if (!cleanRoomId || !cleanText) return;

            const language = sourceLanguage === "es" ? "es" : "en";

            console.log(
                `CHAT ${socket.id} | room=${cleanRoomId} | language=${language} | ${cleanText}`
            );

            const { translatedText, targetLanguage } =
                await translateText(cleanText, language);

            const translatedMessage = {
                ...message,
                original: cleanText,
                translated: translatedText,
                sourceLanguage: language,
                targetLanguage,
            };

            socket.emit("chat-message-translated", translatedMessage);
            socket.to(cleanRoomId).emit("chat-message", translatedMessage);
        } catch (error) {
            console.error(
                "Translation failed:",
                error.response?.data || error.message
            );

            socket.emit("chat-translation-error", {
                messageId: message?.id,
                error:
                    error.response?.data?.message ||
                    error.message ||
                    "Translation failed.",
            });
        }
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        translationProvider: "DeepL",
        translationConfigured: Boolean(DEEPL_API_KEY),
    });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Signaling server running on port ${PORT}`);

    if (DEEPL_API_KEY) {
        console.log("DeepL translation configured.");
    } else {
        console.log("WARNING: DEEPL_API_KEY is not configured.");
    }
});
