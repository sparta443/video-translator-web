import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import "./App.css";

type Language = "en" | "es";

type Message = {
    id: number;
    sender: "me" | "other";
    original: string;
    translated: string;
    sourceLanguage?: Language;
    targetLanguage?: Language;
};

function App() {
    const localVideoRef = useRef<HTMLVideoElement | null>(null);
    const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const socketRef = useRef<Socket | null>(null);

    const [stream, setStream] = useState<MediaStream | null>(null);

    const [cameraOn, setCameraOn] = useState(true);
    const [micOn, setMicOn] = useState(true);

    const [cameraError, setCameraError] = useState("");

    const [roomId, setRoomId] = useState("");
    const [joined, setJoined] = useState(false);
    const [connected, setConnected] = useState(false);

    const [myLanguage, setMyLanguage] = useState<Language>("en");
    const [chatOpen, setChatOpen] = useState(true);

    const [input, setInput] = useState("");
    const [messages, setMessages] = useState<Message[]>([]);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const roomFromUrl = params.get("room");

        if (roomFromUrl) {
            setRoomId(roomFromUrl);
        }
    }, []);

    useEffect(() => {
        let currentStream: MediaStream | null = null;

        async function startCamera() {
            try {
                const mediaStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: true,
                });

                currentStream = mediaStream;
                setStream(mediaStream);

                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = mediaStream;
                }
            } catch (error) {
                console.error(error);
                setCameraError("Camera or microphone access failed.");
            }
        }

        startCamera();

        return () => {
            currentStream?.getTracks().forEach((track) => track.stop());

            if (socketRef.current) {
                socketRef.current.removeAllListeners();
                socketRef.current.disconnect();
            }

            if (peerConnectionRef.current) {
                peerConnectionRef.current.close();
                peerConnectionRef.current = null;
            }
        };
    }, []);

    const languageLabel = useMemo(
        () => (myLanguage === "en" ? "English" : "Spanish"),
        [myLanguage]
    );

    const targetLanguageLabel = useMemo(
        () => (myLanguage === "en" ? "Spanish" : "English"),
        [myLanguage]
    );

    const createPeerConnection = () => {
        if (peerConnectionRef.current) {
            return peerConnectionRef.current;
        }

        const peerConnection = new RTCPeerConnection({
            iceServers: [
                {
                    urls: "stun:stun.l.google.com:19302",
                },
            ],
        });

        if (stream) {
            stream.getTracks().forEach((track) => {
                peerConnection.addTrack(track, stream);
            });
        }

        peerConnection.ontrack = (event) => {
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = event.streams[0];
            }

            setConnected(true);
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate && socketRef.current) {
                socketRef.current.emit("ice-candidate", {
                    roomId: roomId.trim(),
                    candidate: event.candidate,
                });
            }
        };

        peerConnection.onconnectionstatechange = () => {
            if (peerConnection.connectionState === "connected") {
                setConnected(true);
            }

            if (
                ["failed", "closed", "disconnected"].includes(
                    peerConnection.connectionState
                )
            ) {
                setConnected(false);
            }
        };

        peerConnectionRef.current = peerConnection;

        return peerConnection;
    };

    const joinRoom = (selectedRoomId?: string) => {
        if (!stream) {
            alert("Camera is still loading. Please try again.");
            return;
        }

        const cleanRoomId = (selectedRoomId ?? roomId).trim();

        if (!cleanRoomId) {
            alert("Enter a room ID.");
            return;
        }

        setRoomId(cleanRoomId);

        const url = new URL(window.location.href);
        url.searchParams.set("room", cleanRoomId);
        window.history.replaceState({}, "", url.toString());

        if (socketRef.current) {
            socketRef.current.removeAllListeners();
            socketRef.current.disconnect();
        }

        const signalingUrl =
            import.meta.env.VITE_SIGNALING_URL || "http://localhost:3001";

        const socket = io(signalingUrl, {
            transports: ["websocket"],
        });

        socketRef.current = socket;

        socket.on("connect", () => {
            socket.emit("join-room", cleanRoomId);
            setJoined(true);
        });

        socket.on("chat-message", (message: Message) => {
            setMessages((previous) => [
                ...previous,
                {
                    ...message,
                    sender: "other",
                },
            ]);
        });

        socket.on("chat-message-translated", (translatedMessage: Message) => {
            setMessages((previous) =>
                previous.map((message) =>
                    message.id === translatedMessage.id
                        ? {
                            ...translatedMessage,
                            sender: "me",
                        }
                        : message
                )
            );
        });

        socket.on(
            "chat-translation-error",
            ({
                 messageId,
             }: {
                messageId: number;
                error: string;
            }) => {
                setMessages((previous) =>
                    previous.map((message) =>
                        message.id === messageId
                            ? {
                                ...message,
                                translated: "Translation failed",
                            }
                            : message
                    )
                );
            }
        );

        socket.on("user-joined", async () => {
            const peerConnection = createPeerConnection();

            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            socket.emit("offer", {
                roomId: cleanRoomId,
                offer,
            });
        });

        socket.on(
            "offer",
            async (offer: RTCSessionDescriptionInit) => {
                const peerConnection = createPeerConnection();

                await peerConnection.setRemoteDescription(
                    new RTCSessionDescription(offer)
                );

                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);

                socket.emit("answer", {
                    roomId: cleanRoomId,
                    answer,
                });
            }
        );

        socket.on(
            "answer",
            async (answer: RTCSessionDescriptionInit) => {
                const peerConnection = peerConnectionRef.current;

                if (!peerConnection) return;

                await peerConnection.setRemoteDescription(
                    new RTCSessionDescription(answer)
                );
            }
        );

        socket.on(
            "ice-candidate",
            async (candidate: RTCIceCandidateInit) => {
                const peerConnection = peerConnectionRef.current;

                if (!peerConnection) return;

                try {
                    await peerConnection.addIceCandidate(
                        new RTCIceCandidate(candidate)
                    );
                } catch (error) {
                    console.error("ICE candidate error:", error);
                }
            }
        );

        socket.on("disconnect", () => {
            setConnected(false);
        });
    };

    const createRoom = () => {
        const newRoomId = Math.random().toString(36).slice(2, 8).toUpperCase();
        joinRoom(newRoomId);
    };

    const shareRoom = async () => {
        const shareUrl = new URL(window.location.href);
        shareUrl.searchParams.set("room", roomId.trim());

        try {
            if (navigator.share) {
                await navigator.share({
                    title: "Join my Video Translate call",
                    text: "Join my video call with live English ↔ Spanish translation.",
                    url: shareUrl.toString(),
                });
            } else {
                await navigator.clipboard.writeText(shareUrl.toString());
                alert("Room link copied to clipboard.");
            }
        } catch (error) {
            console.error("Share failed:", error);
        }
    };

    const leaveCall = () => {
        socketRef.current?.removeAllListeners();
        socketRef.current?.disconnect();
        socketRef.current = null;

        peerConnectionRef.current?.close();
        peerConnectionRef.current = null;

        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
        }

        setJoined(false);
        setConnected(false);
        setMessages([]);

        const url = new URL(window.location.href);
        url.searchParams.delete("room");
        window.history.replaceState({}, "", url.toString());
    };

    const toggleCamera = () => {
        const videoTrack = stream?.getVideoTracks()[0];

        if (!videoTrack) return;

        videoTrack.enabled = !videoTrack.enabled;
        setCameraOn(videoTrack.enabled);
    };

    const toggleMic = () => {
        const audioTrack = stream?.getAudioTracks()[0];

        if (!audioTrack) return;

        audioTrack.enabled = !audioTrack.enabled;
        setMicOn(audioTrack.enabled);
    };

    const sendMessage = () => {
        const text = input.trim();

        if (!text) return;

        const socket = socketRef.current;

        if (!socket || !socket.connected) {
            alert("Chat connection is not ready.");
            return;
        }

        const newMessage: Message = {
            id: Date.now(),
            sender: "me",
            original: text,
            translated: "Translating...",
            sourceLanguage: myLanguage,
            targetLanguage: myLanguage === "en" ? "es" : "en",
        };

        setMessages((previous) => [...previous, newMessage]);

        socket.emit("chat-message", {
            roomId: roomId.trim(),
            message: newMessage,
            sourceLanguage: myLanguage,
        });

        setInput("");
    };

    return (
        <div className="app">
            <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="remote-video"
            />

            {!joined && (
                <div className="lobby-overlay">
                    <div className="lobby-card">
                        <div className="lobby-brand">Video Translate</div>
                        <h1>Video calls without the language barrier</h1>
                        <p className="lobby-subtitle">
                            Call, chat and translate between English and Spanish in real time.
                        </p>

                        <label className="field-label">Your language</label>
                        <select
                            value={myLanguage}
                            onChange={(e) => setMyLanguage(e.target.value as Language)}
                            className="language-select"
                        >
                            <option value="en">English</option>
                            <option value="es">Español</option>
                        </select>

                        <button className="primary-action" onClick={createRoom}>
                            Create new room
                        </button>

                        <div className="or-divider">
                            <span>or join an existing room</span>
                        </div>

                        <div className="join-row">
                            <input
                                value={roomId}
                                onChange={(e) => setRoomId(e.target.value)}
                                placeholder="Enter room ID"
                            />
                            <button onClick={() => joinRoom()}>Join</button>
                        </div>

                        {cameraError && (
                            <div className="lobby-error">{cameraError}</div>
                        )}
                    </div>
                </div>
            )}

            {joined && !connected && (
                <div className="remote-placeholder">
                    <div className="waiting-card">
                        <h2>Waiting for the other person…</h2>
                        <p>
                            Room <strong>{roomId}</strong>
                        </p>
                        <button className="share-room-button" onClick={shareRoom}>
                            Share room link
                        </button>
                    </div>
                </div>
            )}

            <div className="video-gradient" />

            {joined && (
                <>
                    <header className="top-bar">
                        <div>
                            <h2>Video Translate</h2>

                            <span className="status">
                <span
                    className={`status-dot ${connected ? "online" : ""}`}
                />
                                {connected ? "Connected" : "Waiting..."}
              </span>
                        </div>

                        <div className="top-actions">
                            <button className="share-top-button" onClick={shareRoom}>
                                Share
                            </button>

                            <div className="language-pill">
                                {languageLabel} ↔ {targetLanguageLabel}
                            </div>
                        </div>
                    </header>

                    <div className="self-video">
                        {cameraError ? (
                            <div className="camera-placeholder">{cameraError}</div>
                        ) : (
                            <video
                                ref={localVideoRef}
                                autoPlay
                                muted
                                playsInline
                                className="local-video"
                            />
                        )}

                        <span className="self-label">You</span>
                    </div>

                    {chatOpen && (
                        <section className="chat-panel">
                            <div className="chat-header">
                                <div>
                                    <strong>Live Translation</strong>
                                    <span>
                    {languageLabel} ↔ {targetLanguageLabel}
                  </span>
                                </div>

                                <button
                                    className="minimize-button"
                                    onClick={() => setChatOpen(false)}
                                    aria-label="Close chat"
                                >
                                    ×
                                </button>
                            </div>

                            <div className="messages">
                                {messages.length === 0 && (
                                    <div className="empty-chat">
                                        Send a message. It will be translated automatically.
                                    </div>
                                )}

                                {messages.map((message) => (
                                    <div
                                        key={message.id}
                                        className={`message-row ${
                                            message.sender === "me" ? "mine" : ""
                                        }`}
                                    >
                                        <div className="message-bubble">
                                            <div className="original">{message.original}</div>
                                            <div className="translation">
                                                {message.translated}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <div className="message-input">
                                <input
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            sendMessage();
                                        }
                                    }}
                                    placeholder={
                                        myLanguage === "en"
                                            ? "Type in English..."
                                            : "Escribe en Español..."
                                    }
                                />

                                <button onClick={sendMessage}>➤</button>
                            </div>
                        </section>
                    )}

                    <div className="call-controls">
                        <button onClick={toggleMic}>
                            {micOn ? "🎤" : "🔇"}
                        </button>

                        <button onClick={toggleCamera}>
                            {cameraOn ? "📹" : "🚫"}
                        </button>

                        <button
                            className={chatOpen ? "control-active" : ""}
                            onClick={() => setChatOpen((value) => !value)}
                        >
                            💬
                        </button>

                        <button className="hangup" onClick={leaveCall}>
                            ☎
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

export default App;
