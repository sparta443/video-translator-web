import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import "./App.css";

type Language = "en" | "es";

type Message = {
    id: number;
    sender: "me" | "other";
    senderName: string;
    original: string;
    translated: string;
    sourceLanguage?: Language;
    targetLanguage?: Language;
};

function App() {
    const localVideoRef = useRef<HTMLVideoElement | null>(null);
    const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
    const messagesContainerRef = useRef<HTMLDivElement | null>(null);

    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const socketRef = useRef<Socket | null>(null);

    const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

    const [stream, setStream] = useState<MediaStream | null>(null);

    const [cameraOn, setCameraOn] = useState(true);
    const [micOn, setMicOn] = useState(true);

    const [cameraError, setCameraError] = useState("");
    const [isCameraLoading, setIsCameraLoading] = useState(true);

    const [roomId, setRoomId] = useState("");
    const [joined, setJoined] = useState(false);
    const [connected, setConnected] = useState(false);

    const [myLanguage, setMyLanguage] = useState<Language>("en");

    /*
     * User's display name.
     */
    const [myName, setMyName] = useState("");

    /*
     * Chat is closed by default.
     */
    const [chatOpen, setChatOpen] = useState(false);

    const [input, setInput] = useState("");
    const [messages, setMessages] = useState<Message[]>([]);

    /*
     * Read room ID from URL.
     */
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const roomFromUrl = params.get("room");

        if (roomFromUrl) {
            setRoomId(roomFromUrl);
        }
    }, []);

    /*
     * Automatically scroll to the newest message.
     */
    useEffect(() => {
        const container = messagesContainerRef.current;

        if (!container) {
            return;
        }

        container.scrollTo({
            top: container.scrollHeight,
            behavior: "smooth",
        });
    }, [messages]);

    /*
     * Start camera and microphone.
     */
    useEffect(() => {
        let currentStream: MediaStream | null = null;

        async function startCamera() {
            setIsCameraLoading(true);
            setCameraError("");

            try {
                if (
                    !navigator.mediaDevices ||
                    !navigator.mediaDevices.getUserMedia
                ) {
                    throw new Error(
                        "Camera and microphone are not supported by this browser."
                    );
                }

                const mediaStream =
                    await navigator.mediaDevices.getUserMedia({
                        video: true,
                        audio: true,
                    });

                currentStream = mediaStream;

                setStream(mediaStream);

                setCameraOn(
                    mediaStream
                        .getVideoTracks()
                        .some((track) => track.enabled)
                );

                setMicOn(
                    mediaStream
                        .getAudioTracks()
                        .some((track) => track.enabled)
                );

                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = mediaStream;
                }
            } catch (error) {
                console.error("Camera/microphone error:", error);

                setCameraError(
                    "Camera or microphone access failed. Please allow permissions and try again."
                );
            } finally {
                setIsCameraLoading(false);
            }
        }

        startCamera();

        return () => {
            currentStream?.getTracks().forEach((track) => track.stop());

            if (socketRef.current) {
                socketRef.current.removeAllListeners();
                socketRef.current.disconnect();
                socketRef.current = null;
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

    /*
     * Create WebRTC peer connection.
     */
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

        /*
         * Add local camera and microphone tracks.
         */
        if (stream) {
            stream.getTracks().forEach((track) => {
                peerConnection.addTrack(track, stream);
            });
        }

        /*
         * Receive remote video/audio.
         */
        peerConnection.ontrack = (event) => {
            console.log("Remote track received");

            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = event.streams[0];

                remoteVideoRef.current.play().catch((error) => {
                    console.warn(
                        "Remote video autoplay was blocked:",
                        error
                    );
                });
            }

            setConnected(true);
        };

        /*
         * ICE candidates.
         */
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && socketRef.current) {
                socketRef.current.emit("ice-candidate", {
                    roomId: roomId.trim(),
                    candidate: event.candidate,
                });
            }
        };

        /*
         * WebRTC connection state.
         */
        peerConnection.onconnectionstatechange = () => {
            console.log(
                "WebRTC connection state:",
                peerConnection.connectionState
            );

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

        /*
         * ICE connection state.
         */
        peerConnection.oniceconnectionstatechange = () => {
            console.log(
                "ICE connection state:",
                peerConnection.iceConnectionState
            );
        };

        peerConnectionRef.current = peerConnection;

        return peerConnection;
    };

    /*
     * Join an existing room.
     */
    const joinRoom = async (selectedRoomId?: string) => {
        console.log("JOIN BUTTON CLICKED");

        const cleanRoomId = (selectedRoomId ?? roomId).trim();
        const cleanName = myName.trim();

        if (!cleanName) {
            alert("Please enter your name.");
            return;
        }

        if (!cleanRoomId) {
            alert("Enter a room ID.");
            return;
        }

        if (isCameraLoading) {
            console.log(
                "Camera is still loading. Continuing to join room."
            );
        }

        setMyName(cleanName);
        setRoomId(cleanRoomId);

        /*
         * Put room ID into URL.
         */
        const url = new URL(window.location.href);

        url.searchParams.set("room", cleanRoomId);

        window.history.replaceState({}, "", url.toString());

        /*
         * Disconnect old socket.
         */
        if (socketRef.current) {
            socketRef.current.removeAllListeners();
            socketRef.current.disconnect();
            socketRef.current = null;
        }

        /*
         * Signaling server.
         */
        const signalingUrl =
            import.meta.env.VITE_SIGNALING_URL ||
            (window.location.hostname === "localhost"
                ? "http://localhost:3001"
                : "");

        console.log("Signaling URL:", signalingUrl);

        if (!signalingUrl) {
            alert(
                "Call server is not configured. Please set VITE_SIGNALING_URL in Render."
            );

            return;
        }

        /*
         * Socket.IO connection.
         */
        const socket = io(signalingUrl, {
            transports: ["polling"],
            reconnection: true,
            reconnectionAttempts: 5,
        });

        socketRef.current = socket;

        /*
         * Successful socket connection.
         */
        socket.on("connect", () => {
            console.log("Socket connected:", socket.id);

            socket.emit("join-room", cleanRoomId);

            setJoined(true);
        });

        /*
         * Socket connection error.
         */
        socket.on("connect_error", (error) => {
            console.error(
                "Signaling connection failed:",
                error.message
            );

            console.error("Full socket error:", error);

            alert(
                `Signaling connection failed: ${error.message}`
            );
        });

        /*
         * Chat message received from another user.
         */
        socket.on("chat-message", (message: Message) => {
            setMessages((previous) => [
                ...previous,
                {
                    ...message,
                    sender: "other",
                    senderName:
                        message.senderName || "Guest",
                },
            ]);
        });

        /*
         * Translated message received for our own message.
         */
        socket.on(
            "chat-message-translated",
            (translatedMessage: Message) => {
                setMessages((previous) =>
                    previous.map((message) =>
                        message.id === translatedMessage.id
                            ? {
                                ...translatedMessage,
                                sender: "me",
                                senderName:
                                    translatedMessage.senderName ||
                                    cleanName,
                            }
                            : message
                    )
                );
            }
        );

        /*
         * Translation error.
         */
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
                                translated:
                                    "Translation failed",
                            }
                            : message
                    )
                );
            }
        );

        /*
         * Another user joined.
         *
         * This user becomes the offer creator.
         */
        socket.on("user-joined", async () => {
            try {
                console.log("Another user joined");

                const peerConnection =
                    createPeerConnection();

                const offer =
                    await peerConnection.createOffer();

                await peerConnection.setLocalDescription(
                    offer
                );

                socket.emit("offer", {
                    roomId: cleanRoomId,
                    offer,
                });
            } catch (error) {
                console.error(
                    "Error creating offer:",
                    error
                );
            }
        });

        /*
         * Receive offer.
         */
        socket.on(
            "offer",
            async (offer: RTCSessionDescriptionInit) => {
                try {
                    console.log("Offer received");

                    const peerConnection =
                        createPeerConnection();

                    await peerConnection.setRemoteDescription(
                        new RTCSessionDescription(offer)
                    );

                    /*
                     * Add ICE candidates that arrived early.
                     */
                    for (const candidate of
                        pendingIceCandidatesRef.current) {
                        try {
                            await peerConnection.addIceCandidate(
                                new RTCIceCandidate(candidate)
                            );
                        } catch (error) {
                            console.error(
                                "Pending ICE candidate error:",
                                error
                            );
                        }
                    }

                    pendingIceCandidatesRef.current = [];

                    const answer =
                        await peerConnection.createAnswer();

                    await peerConnection.setLocalDescription(
                        answer
                    );

                    socket.emit("answer", {
                        roomId: cleanRoomId,
                        answer,
                    });
                } catch (error) {
                    console.error(
                        "Error handling offer:",
                        error
                    );
                }
            }
        );

        /*
         * Receive answer.
         */
        socket.on(
            "answer",
            async (answer: RTCSessionDescriptionInit) => {
                try {
                    console.log("Answer received");

                    const peerConnection =
                        peerConnectionRef.current;

                    if (!peerConnection) {
                        return;
                    }

                    await peerConnection.setRemoteDescription(
                        new RTCSessionDescription(answer)
                    );

                    /*
                     * Add queued ICE candidates.
                     */
                    for (const candidate of
                        pendingIceCandidatesRef.current) {
                        try {
                            await peerConnection.addIceCandidate(
                                new RTCIceCandidate(candidate)
                            );
                        } catch (error) {
                            console.error(
                                "Pending ICE candidate error:",
                                error
                            );
                        }
                    }

                    pendingIceCandidatesRef.current = [];
                } catch (error) {
                    console.error(
                        "Error handling answer:",
                        error
                    );
                }
            }
        );

        /*
         * Receive ICE candidate.
         */
        socket.on(
            "ice-candidate",
            async (candidate: RTCIceCandidateInit) => {
                const peerConnection =
                    peerConnectionRef.current;

                if (!peerConnection) {
                    pendingIceCandidatesRef.current.push(
                        candidate
                    );

                    return;
                }

                /*
                 * If remote description isn't available yet,
                 * queue the candidate.
                 */
                if (!peerConnection.remoteDescription) {
                    pendingIceCandidatesRef.current.push(
                        candidate
                    );

                    return;
                }

                try {
                    await peerConnection.addIceCandidate(
                        new RTCIceCandidate(candidate)
                    );
                } catch (error) {
                    console.error(
                        "ICE candidate error:",
                        error
                    );
                }
            }
        );

        /*
         * Socket disconnected.
         */
        socket.on("disconnect", (reason) => {
            console.log(
                "Socket disconnected:",
                reason
            );

            setConnected(false);
        });
    };

    /*
     * Create a new room.
     */
    const createRoom = () => {
        const newRoomId = Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase();

        console.log("Creating room:", newRoomId);

        joinRoom(newRoomId);
    };

    /*
     * Share room.
     */
    const shareRoom = async () => {
        if (!roomId.trim()) {
            return;
        }

        const shareUrl = new URL(window.location.href);

        shareUrl.searchParams.set(
            "room",
            roomId.trim()
        );

        try {
            if (navigator.share) {
                await navigator.share({
                    title: "Join my Video Translate call",
                    text:
                        "Join my video call with live English ↔ Spanish translation.",
                    url: shareUrl.toString(),
                });
            } else if (navigator.clipboard) {
                await navigator.clipboard.writeText(
                    shareUrl.toString()
                );

                alert("Room link copied to clipboard.");
            } else {
                alert(shareUrl.toString());
            }
        } catch (error) {
            console.error(
                "Share failed:",
                error
            );
        }
    };

    /*
     * Leave call.
     */
    const leaveCall = () => {
        socketRef.current?.removeAllListeners();
        socketRef.current?.disconnect();
        socketRef.current = null;

        peerConnectionRef.current?.close();
        peerConnectionRef.current = null;

        pendingIceCandidatesRef.current = [];

        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
        }

        setJoined(false);
        setConnected(false);
        setMessages([]);
        setChatOpen(false);
        setInput("");

        const url = new URL(window.location.href);

        url.searchParams.delete("room");

        window.history.replaceState(
            {},
            "",
            url.toString()
        );
    };

    /*
     * Toggle camera.
     */
    const toggleCamera = () => {
        const videoTrack =
            stream?.getVideoTracks()[0];

        if (!videoTrack) {
            alert("Camera is not available.");
            return;
        }

        videoTrack.enabled = !videoTrack.enabled;

        setCameraOn(videoTrack.enabled);
    };

    /*
     * Toggle microphone.
     */
    const toggleMic = () => {
        const audioTrack =
            stream?.getAudioTracks()[0];

        if (!audioTrack) {
            alert("Microphone is not available.");
            return;
        }

        audioTrack.enabled = !audioTrack.enabled;

        setMicOn(audioTrack.enabled);
    };

    /*
     * Send chat message.
     */
    const sendMessage = () => {
        const text = input.trim();
        const cleanName = myName.trim();

        if (!text) {
            return;
        }

        if (!cleanName) {
            alert("Please enter your name.");
            return;
        }

        const socket = socketRef.current;

        if (!socket || !socket.connected) {
            alert("Chat connection is not ready.");
            return;
        }

        const newMessage: Message = {
            id: Date.now(),
            sender: "me",
            senderName: cleanName,
            original: text,
            translated: "Translating...",
            sourceLanguage: myLanguage,
            targetLanguage:
                myLanguage === "en" ? "es" : "en",
        };

        setMessages((previous) => [
            ...previous,
            newMessage,
        ]);

        socket.emit("chat-message", {
            roomId: roomId.trim(),
            message: newMessage,
            sourceLanguage: myLanguage,
        });

        setInput("");
    };

    return (
        <div className="app">
            {/* Remote video */}
            <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="remote-video"
            />

            {/* Lobby */}
            {!joined && (
                <div className="lobby-overlay">
                    <div className="lobby-card">
                        <div className="lobby-brand">
                            Video Translate
                        </div>

                        <h1>
                            Video calls without the language
                            barrier
                        </h1>

                        <p className="lobby-subtitle">
                            Call, chat and translate between
                            English and Spanish in real time.
                        </p>

                        {/* Name */}
                        <label className="field-label">
                            Your name
                        </label>

                        <input
                            value={myName}
                            onChange={(e) =>
                                setMyName(e.target.value)
                            }
                            placeholder="Enter your name"
                            maxLength={30}
                            className="name-input"
                            autoComplete="name"
                        />

                        <label className="field-label">
                            Your language
                        </label>

                        <select
                            value={myLanguage}
                            onChange={(e) =>
                                setMyLanguage(
                                    e.target.value as Language
                                )
                            }
                            className="language-select"
                        >
                            <option value="en">
                                English
                            </option>

                            <option value="es">
                                Español
                            </option>
                        </select>

                        <button
                            className="primary-action"
                            onClick={createRoom}
                            type="button"
                        >
                            {isCameraLoading
                                ? "Preparing camera..."
                                : "Create new room"}
                        </button>

                        <div className="or-divider">
                            <span>
                                or join an existing room
                            </span>
                        </div>

                        <div className="join-row">
                            <input
                                value={roomId}
                                onChange={(e) =>
                                    setRoomId(e.target.value)
                                }
                                placeholder="Enter room ID"
                                autoCapitalize="characters"
                                autoCorrect="off"
                                spellCheck={false}
                            />

                            <button
                                onClick={() => joinRoom()}
                                type="button"
                            >
                                Join
                            </button>
                        </div>

                        {cameraError && (
                            <div className="lobby-error">
                                {cameraError}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Waiting for other user */}
            {joined && !connected && (
                <div className="remote-placeholder">
                    <div className="waiting-card">
                        <h2>
                            Waiting for the other person…
                        </h2>

                        <p>
                            Room{" "}
                            <strong>{roomId}</strong>
                        </p>

                        <button
                            className="share-room-button"
                            onClick={shareRoom}
                            type="button"
                        >
                            Share room link
                        </button>
                    </div>
                </div>
            )}

            <div className="video-gradient" />

            {/* Active call UI */}
            {joined && (
                <>
                    <header className="top-bar">
                        <div>
                            <h2>Video Translate</h2>

                            <span className="status">
                                <span
                                    className={`status-dot ${
                                        connected
                                            ? "online"
                                            : ""
                                    }`}
                                />

                                {connected
                                    ? "Connected"
                                    : "Waiting..."}
                            </span>
                        </div>

                        <div className="top-actions">
                            <button
                                className="share-top-button"
                                onClick={shareRoom}
                                type="button"
                            >
                                Share
                            </button>

                            <div className="language-pill">
                                {languageLabel} ↔{" "}
                                {targetLanguageLabel}
                            </div>
                        </div>
                    </header>

                    {/* Local video */}
                    <div className="self-video">
                        {cameraError ? (
                            <div className="camera-placeholder">
                                {cameraError}
                            </div>
                        ) : (
                            <video
                                ref={localVideoRef}
                                autoPlay
                                muted
                                playsInline
                                className="local-video"
                            />
                        )}

                        <span className="self-label">
                            You
                        </span>
                    </div>

                    {/* Transparent chat overlay */}
                    <section
                        className={`chat-overlay ${
                            chatOpen ? "open" : ""
                        }`}
                    >
                        <div
                            className="overlay-messages"
                            ref={messagesContainerRef}
                            aria-live="polite"
                        >
                            {messages.map((message) => (
                                <div
                                    key={message.id}
                                    className={`overlay-message ${
                                        message.sender === "me"
                                            ? "mine"
                                            : "other"
                                    }`}
                                >
                                    <div className="overlay-sender">
                                        {message.senderName}
                                    </div>

                                    <div className="overlay-original">
                                        {message.original}
                                    </div>

                                    {message.translated && (
                                        <div className="overlay-translation">
                                            {message.translated}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>

                        {/* Message input */}
                        {chatOpen && (
                            <div className="overlay-input">
                                <input
                                    value={input}
                                    onChange={(e) =>
                                        setInput(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (
                                            e.key === "Enter"
                                        ) {
                                            sendMessage();
                                        }
                                    }}
                                    placeholder={
                                        myLanguage === "en"
                                            ? "Type in English..."
                                            : "Escribe en Español..."
                                    }
                                />

                                <button
                                    onClick={sendMessage}
                                    type="button"
                                    aria-label="Send message"
                                >
                                    ➤
                                </button>
                            </div>
                        )}
                    </section>

                    {/* Call controls */}
                    <div className="call-controls">
                        <button
                            onClick={toggleMic}
                            type="button"
                            aria-label="Toggle microphone"
                        >
                            {micOn ? "🎤" : "🔇"}
                        </button>

                        <button
                            onClick={toggleCamera}
                            type="button"
                            aria-label="Toggle camera"
                        >
                            {cameraOn ? "📹" : "🚫"}
                        </button>

                        <button
                            className={
                                chatOpen
                                    ? "control-active"
                                    : ""
                            }
                            onClick={() =>
                                setChatOpen(
                                    (value) => !value
                                )
                            }
                            type="button"
                            aria-label="Toggle chat"
                        >
                            💬
                        </button>

                        <button
                            className="hangup"
                            onClick={leaveCall}
                            type="button"
                            aria-label="Leave call"
                        >
                            ☎
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

export default App;