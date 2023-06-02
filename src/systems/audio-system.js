import { LogMessageType } from "../react-components/room/ChatSidebar";
import { AudioType, GAIN_TIME_CONST, SourceType } from "../components/audio-params";

let delayedReconnectTimeout = null;
function performDelayedReconnect(gainNode) {
  if (delayedReconnectTimeout) {
    clearTimeout(delayedReconnectTimeout);
  }

  delayedReconnectTimeout = setTimeout(() => {
    delayedReconnectTimeout = null;
    console.warn(
      "enableChromeAEC: recreate RTCPeerConnection loopback because the local connection was disconnected for 10s"
    );
    // eslint-disable-next-line no-use-before-define
    enableChromeAEC(gainNode);
  }, 10000);
}

import * as sdpTransform from "sdp-transform";
import MediaDevicesManager from "../utils/media-devices-manager";
import { isPositionalAudio, swapAudioType, updatePannerNode } from "../bit-systems/audio-emitter-system";
import { getCurrentAudioSettings, updateAudioSettings } from "../update-audio-settings";

async function enableChromeAEC(gainNode) {
  /**
   *  workaround for: https://bugs.chromium.org/p/chromium/issues/detail?id=687574
   *  1. grab the listener from the audio context
   *  2. disconnect the GainNode from the AudioDestinationNode (basically the audio out), this prevents hearing the audio twice.
   *  3. create a local webrtc connection between two RTCPeerConnections (see this example: https://webrtc.github.io/samples/src/content/peerconnection/pc1/)
   *  4. create a new MediaStreamDestination from the scene's THREE.AudioContext and connect the GainNode to it.
   *  5. add the MediaStreamDestination's track  to one of those RTCPeerConnections
   *  6. connect the other RTCPeerConnection's stream to a new audio element.
   *  All audio is now routed through Chrome's audio mixer, thus enabling AEC, while preserving all the audio processing that was performed via the WebAudio API.
   */

  const audioEl = new Audio();
  audioEl.setAttribute("autoplay", "autoplay");
  audioEl.setAttribute("playsinline", "playsinline");

  const context = APP.audioCtx;
  const loopbackDestination = context.createMediaStreamDestination();
  const outboundPeerConnection = new RTCPeerConnection();
  const inboundPeerConnection = new RTCPeerConnection();

  const onError = e => {
    console.error("enableChromeAEC: RTCPeerConnection loopback initialization error", e);
  };

  outboundPeerConnection.addEventListener("icecandidate", e => {
    inboundPeerConnection.addIceCandidate(e.candidate).catch(onError);
  });
  outboundPeerConnection.addEventListener("iceconnectionstatechange", () => {
    console.warn(
      "enableChromeAEC: outboundPeerConnection state changed to " + outboundPeerConnection.iceConnectionState
    );
    if (outboundPeerConnection.iceConnectionState === "disconnected") {
      performDelayedReconnect(gainNode);
    }
    if (outboundPeerConnection.iceConnectionState === "connected") {
      if (delayedReconnectTimeout) {
        // The RTCPeerConnection reconnected by itself, cancel recreating the
        // local connection.
        clearTimeout(delayedReconnectTimeout);
      }
    }
  });

  inboundPeerConnection.addEventListener("icecandidate", e => {
    outboundPeerConnection.addIceCandidate(e.candidate).catch(onError);
  });
  inboundPeerConnection.addEventListener("iceconnectionstatechange", () => {
    console.warn("enableChromeAEC: inboundPeerConnection state changed to " + inboundPeerConnection.iceConnectionState);
    if (inboundPeerConnection.iceConnectionState === "disconnected") {
      performDelayedReconnect(gainNode);
    }
    if (inboundPeerConnection.iceConnectionState === "connected") {
      if (delayedReconnectTimeout) {
        // The RTCPeerConnection reconnected by itself, cancel recreating the
        // local connection.
        clearTimeout(delayedReconnectTimeout);
      }
    }
  });

  inboundPeerConnection.addEventListener("track", e => {
    audioEl.srcObject = e.streams[0];
  });

  try {
    //The following should never fail, but just in case, we won't disconnect/reconnect the gainNode unless all of this succeeds
    loopbackDestination.stream.getTracks().forEach(track => {
      outboundPeerConnection.addTrack(track, loopbackDestination.stream);
    });

    const offer = await outboundPeerConnection.createOffer();
    outboundPeerConnection.setLocalDescription(offer);
    await inboundPeerConnection.setRemoteDescription(offer);

    const answer = await inboundPeerConnection.createAnswer();

    // Rewrite SDP to be stereo and (variable) max bitrate
    const parsedSdp = sdpTransform.parse(answer.sdp);
    for (let i = 0; i < parsedSdp.media.length; i++) {
      for (let j = 0; j < parsedSdp.media[i].fmtp.length; j++) {
        parsedSdp.media[i].fmtp[j].config += `;stereo=1;cbr=0;maxaveragebitrate=510000;`;
      }
    }
    answer.sdp = sdpTransform.write(parsedSdp);

    inboundPeerConnection.setLocalDescription(answer);
    outboundPeerConnection.setRemoteDescription(answer);

    gainNode.disconnect();
    gainNode.connect(loopbackDestination);
  } catch (e) {
    onError(e);
  }
}

export class AudioSystem {
  constructor(sceneEl) {
    this._sceneEl = sceneEl;

    this.audioContext = APP.audioCtx;
    this.audioNodes = new Map();
    this.mediaStreamDestinationNode = this.audioContext.createMediaStreamDestination(); // Voice, camera, screenshare
    this.destinationGain = APP.audioCtx.createGain();
    this.destinationGain.connect(APP.audioCtx.destination);
    this.audioDestination = this.audioContext.createMediaStreamDestination(); // Media elements
    this.outboundStream = this.mediaStreamDestinationNode.stream;
    this.outboundGainNode = this.audioContext.createGain();
    this.outboundAnalyser = this.audioContext.createAnalyser();
    this.outboundAnalyser.fftSize = 32;
    this.analyserLevels = new Uint8Array(this.outboundAnalyser.fftSize);
    this.outboundGainNode.connect(this.outboundAnalyser);
    this.outboundAnalyser.connect(this.mediaStreamDestinationNode);
    this.audioContextNeedsToBeResumed = false;

    this.mediaGain = this.audioContext.createGain();
    this.mixer = {
      [SourceType.AVATAR_AUDIO_SOURCE]: this.audioContext.createGain(),
      [SourceType.MEDIA_VIDEO]: this.mediaGain,
      [SourceType.AUDIO_TARGET]: this.mediaGain,
      [SourceType.SFX]: this.audioContext.createGain()
    };
    this.mixer[SourceType.AVATAR_AUDIO_SOURCE].connect(this.destinationGain);
    this.mixer[SourceType.MEDIA_VIDEO].connect(this.destinationGain);
    this.mixer[SourceType.SFX].connect(this.destinationGain);

    // Analyser to show the output audio level
    this.mixerAnalyser = this.audioContext.createAnalyser();
    this.mixerAnalyser.fftSize = 32;
    this.mixer[SourceType.AVATAR_AUDIO_SOURCE].connect(this.mixerAnalyser);
    this.mixer[SourceType.MEDIA_VIDEO].connect(this.mixerAnalyser);
    this.mixer[SourceType.SFX].connect(this.mixerAnalyser);

    // Webkit Mobile fix
    this._safariMobileAudioInterruptionFix();

    document.body.addEventListener("touchend", this._resumeAudioContext, false);
    document.body.addEventListener("mouseup", this._resumeAudioContext, false);

    const { disableLeftRightPanning, audioPanningQuality } = APP.store.state.preferences;
    this.disableLeftRightPanning = disableLeftRightPanning;
    this.audioPanningQuality = audioPanningQuality;
    this.onPrefsUpdated = this.updatePrefs.bind(this);
    APP.store.addEventListener("statechanged", this.onPrefsUpdated);
  }

  addStreamToOutboundAudio(id, mediaStream) {
    if (this.audioNodes.has(id)) {
      this.removeStreamFromOutboundAudio(id);
    }

    const sourceNode = this.audioContext.createMediaStreamSource(mediaStream);
    const gainNode = this.audioContext.createGain();
    sourceNode.connect(gainNode);
    gainNode.connect(this.outboundGainNode);
    this.audioNodes.set(id, { sourceNode, gainNode });
  }

  removeStreamFromOutboundAudio(id) {
    if (this.audioNodes.has(id)) {
      const nodes = this.audioNodes.get(id);
      nodes.sourceNode.disconnect();
      nodes.gainNode.disconnect();
      this.audioNodes.delete(id);
    }
  }

  getListenerInput() {
    return this.destinationGain;
  }

  addAudio({ node, sourceType }) {
    node.disconnect();
    node.connect(this.mixer[sourceType]);
  }

  removeAudio({ node }) {
    node.disconnect();
  }

  updatePrefs() {
    const { globalVoiceVolume, globalMediaVolume, globalSFXVolume } = APP.store.state.preferences;
    let newGain = globalMediaVolume / 100;
    this.mixer[SourceType.MEDIA_VIDEO].gain.setTargetAtTime(newGain, this.audioContext.currentTime, GAIN_TIME_CONST);

    newGain = globalSFXVolume / 100;
    this.mixer[SourceType.SFX].gain.setTargetAtTime(newGain, this.audioContext.currentTime, GAIN_TIME_CONST);

    newGain = globalVoiceVolume / 100;
    this.mixer[SourceType.AVATAR_AUDIO_SOURCE].gain.setTargetAtTime(
      newGain,
      this.audioContext.currentTime,
      GAIN_TIME_CONST
    );

    if (MediaDevicesManager.isAudioOutputSelectEnabled && APP.mediaDevicesManager) {
      const sinkId = APP.mediaDevicesManager.selectedSpeakersDeviceId;
      const isDefault = sinkId === APP.mediaDevicesManager.defaultOutputDeviceId;
      if ((this.outputMediaAudio || !isDefault) && sinkId !== this.outputMediaAudio?.sinkId) {
        const sink = isDefault ? this.destinationGain : this.audioDestination;
        this.mixer[SourceType.AVATAR_AUDIO_SOURCE].disconnect();
        this.mixer[SourceType.AVATAR_AUDIO_SOURCE].connect(sink);
        this.mixer[SourceType.AVATAR_AUDIO_SOURCE].connect(this.mixerAnalyser);
        this.mixer[SourceType.MEDIA_VIDEO].disconnect();
        this.mixer[SourceType.MEDIA_VIDEO].connect(sink);
        this.mixer[SourceType.MEDIA_VIDEO].connect(this.mixerAnalyser);
        this.mixer[SourceType.SFX].disconnect();
        this.mixer[SourceType.SFX].connect(sink);
        this.mixer[SourceType.SFX].connect(this.mixerAnalyser);
        if (isDefault) {
          if (this.outputMediaAudio) {
            this.outputMediaAudio.pause();
            this.outputMediaAudio.srcObject = null;
            this.outputMediaAudio = null;
          }
        } else {
          // Switching the audio sync is only supported in Chrome at the time of writing this.
          // It also seems to have some limitations and it only works on audio elements. We are piping all our media through the Audio Context
          // and that doesn't seem to work.
          // To workaround that we need to use a MediaStreamAudioDestinationNode that is set as the source of the audio element where we switch the sink.
          // This is very hacky but there don't seem to have any better alternatives at the time of writing this.
          // https://stackoverflow.com/a/67043782
          if (!this.outputMediaAudio) {
            this.outputMediaAudio = new Audio();
            this.outputMediaAudio.srcObject = this.audioDestination.stream;
          }
          if (this.outputMediaAudio.sinkId !== sinkId) {
            this.outputMediaAudio.setSinkId(sinkId).then(() => {
              this.outputMediaAudio.play();
            });
          }
        }
      }
    }

    const newDisableLeftRightPanning = APP.store.state.preferences.disableLeftRightPanning;
    const newAudioPanningQuality = APP.store.state.preferences.audioPanningQuality;

    const shouldRecreateAudio = this.disableLeftRightPanning !== newDisableLeftRightPanning;
    const shouldUpdateAudioSettings = this.audioPanningQuality !== newAudioPanningQuality;

    this.disableLeftRightPanning = newDisableLeftRightPanning;
    this.audioPanningQuality = newAudioPanningQuality;

    APP.audios.forEach((audio, elOrEid) => {
      if (shouldRecreateAudio) {
        const { audioType } = getCurrentAudioSettings(elOrEid);
        if (
          (!isPositionalAudio(audio) && audioType === AudioType.PannerNode) ||
          (isPositionalAudio(audio) && audioType === AudioType.Stereo)
        ) {
          swapAudioType(elOrEid);
          audio = APP.audios.get(elOrEid);
          if (isPositionalAudio(audio)) {
            const obj = APP.world.eid2obj.get(elOrEid.eid);
            updatePannerNode(audio, obj);
          }
        }
      } else if (shouldUpdateAudioSettings) {
        const audio = APP.audios.get(elOrEid);
        updateAudioSettings(elOrEid, audio);
      }
    });
  }

  /**
   * Chrome and Safari will start Audio contexts in a "suspended" state.
   * A user interaction (touch/mouse event) is needed in order to resume the AudioContext.
   */
  _resumeAudioContext = () => {
    this.audioContext.resume();

    setTimeout(() => {
      if (this.audioContext.state === "running") {
        const disableAEC = window.APP.store.state.preferences.disableEchoCancellation;
        if (!AFRAME.utils.device.isMobile() && /chrome/i.test(navigator.userAgent) && !disableAEC) {
          enableChromeAEC(this.destinationGain);
        }

        document.body.removeEventListener("touchend", this._resumeAudioContext, false);
        document.body.removeEventListener("mouseup", this._resumeAudioContext, false);
      }
    }, 0);
  };

  // Webkit mobile fix
  // https://stackoverflow.com/questions/10232908/is-there-a-way-to-detect-a-mobile-safari-audio-interruption-headphones-unplugg
  _safariMobileAudioInterruptionFix() {
    this.audioContext.onstatechange = () => {
      console.log(`AudioContext state changed to ${this.audioContext.state}`);
      if (this.audioContext.state === "suspended") {
        // When you unplug the headphone or when the bluetooth headset disconnects on
        // iOS Safari or Chrome, the state changes to suspended.
        // Chrome Android doesn't go in suspended state for this case.
        document.getElementById("avatar-rig").messageDispatch.log(LogMessageType.audioSuspended);
        document.body.addEventListener("touchend", this._resumeAudioContext, false);
        document.body.addEventListener("mouseup", this._resumeAudioContext, false);
        this.audioContextNeedsToBeResumed = true;
      } else if (this.audioContext.state === "running" && this.audioContextNeedsToBeResumed) {
        this.audioContextNeedsToBeResumed = false;
        document.getElementById("avatar-rig").messageDispatch.log(LogMessageType.audioResumed);
      }
    };
  }
}
