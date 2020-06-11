let jitsirtc = null;

/**
 * WebRTC Client using the JitsiRTC framework for its implementation.
 *
 * @implements {WebRTCInterface}
 * @param {WebRTC} webrtc             The WebRTC object
 * @param {WebRTCSettings} settings   The WebRTC Settings object
 */
class JitsiRTCClient extends WebRTCInterface {
  constructor(webrtc, settings) {
    super(webrtc, settings);

    this._roomhandle = null;
    this._remoteTracks = {};
    this._streams = {};
    this._videofilter = null;

    this._settings = settings;

    const { server } = this._settings.worldSettings;
    this._room = this._settings.worldSettings.server.room;

    if (server.type === 'FVTT') {
      this._options = {
        hosts: {
          domain: 'beta.meet.jit.si',
          muc: 'conference.beta.meet.jit.si',
        },
        bosh: '//beta.meet.jit.si/http-bind',
        clientNode: 'http://beta.meet.jit.si',
      };
      this._auth = {};
    } else {
      let mucUrl = game.settings.get('jitsiwebrtc', 'mucUrl');
      let focusUrl = game.settings.get('jitsiwebrtc', 'focusUrl');
      let boshUrl = game.settings.get('jitsiwebrtc', 'boshUrl');

      // Setup defaults if undefined
      if (mucUrl === '' || mucUrl === 'undefined') {
        mucUrl = `conference.${server.url}`;
        game.settings.set('jitsiwebrtc', 'mucUrl', mucUrl);
      }
      if (focusUrl === '' || focusUrl === 'undefined') {
        focusUrl = `focus.${server.url}`;
        game.settings.set('jitsiwebrtc', 'focusUrl', focusUrl);
      }
      if (boshUrl === '' || boshUrl === 'undefined') {
        boshUrl = `//${server.url}/http-bind`;
        game.settings.set('jitsiwebrtc', 'boshUrl', boshUrl);
      }

      this._options = {
        hosts: {
          domain: server.url,
          muc: mucUrl,
          focus: focusUrl,
        },
        bosh: boshUrl,
        clientNode: 'http://jitsi.org/jitsimeet',
      };
      this._auth = {
        id: server.username,
        password: server.password,
      };
    }

    this._usernameCache = {};
    this._idCache = {};
    this._withAudio = false;
    this._withVideo = false;
  }

  /**
   * Display debug messages on the console if debugging is enabled
   * @param {...*} args      Arguments to console.log
   */
  debug(...args) {
    if (this.settings.debugClient) console.log('JitsiRTC : ', ...args);
  }

  getLocalTracks() {
    if (this._roomhandle) return this._roomhandle.getLocalTracks();
    return [];
  }

  getFilterCanvas() {
    if (this._videofilter) return this._videofilter.getFilterCanvas();
    return null;
  }

  hasActiveFilter() {
    if (this._videofilter) return this._videofilter.hasActiveFilter();

    return false;
  }

  setVideoFilter(filter) {
    this._videofilter = filter;
  }

  async getVideoFilter() {
    if (this._videofilter) return this._videofilter.getVideoFilter();

    return [];
  }

  async initialize() {
    const { mode } = this._settings.worldSettings;
    this._withAudio = ((mode === 1) || (mode === 3));
    this._withVideo = ((mode === 2) || (mode === 3));

    this.debug('initialize withAudio: ', this._withAudio, ' withVideo: ', this._withVideo);

    if (game.webrtc.client._withAudio || game.webrtc.client._withVideo) {
      JitsiMeetJS.init(game.webrtc.client._options);
      JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.ERROR);
      this.debug('JitsiMeetJS init with options ', game.webrtc.client._options);
    }

    return true;
  }

  /**
   * Connect to the Jitsi server.
   *
   * @param {string} host            ignored
   * @param {string} room            ignored
   * @param {string} username        ignored
   * @param {string} password        ignored
   * @return {Promise.boolean}       Returns success/failure to connect
   */
  async connect() {
    return new Promise((resolve) => {
      jitsirtc = new JitsiMeetJS.JitsiConnection(null, null, this._options);

      this.debug('Connection created with options ', this._options);

      jitsirtc.addEventListener(
        JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED,
        this._loginSuccess.bind(this, resolve),
      );
      jitsirtc.addEventListener(
        JitsiMeetJS.events.connection.CONNECTION_FAILED,
        this._loginFailure.bind(this, resolve),
      );
      jitsirtc.addEventListener(
        JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED,
        this._onDisconnect.bind(this, resolve),
      );

      jitsirtc.connect(this._auth);

      this.debug('Async call to connect started.');
    });
  }

  /**
   * Handles incoming remote track
   * @param track JitsiTrack object
   */
  _onRemoteTrack(track) {
    if (track.isLocal()) {
      return;
    }
    const participant = track.getParticipantId();
    const { client } = game.webrtc;

    client.debug('remote track type ', track.getType(), ' from participant ', participant, ' added.');

    if (client._remoteTracks[participant] == null) client._remoteTracks[participant] = [];

    client._remoteTracks[participant].push(track);
    const userId = client._idCache[participant];

    if (userId != null) {
      const stream = client.getStreamForUser(userId);
      stream.addTrack(track.track);
      game.webrtc.onUserStreamChange(userId, client.getStreamForUser(userId));
    } else {
      client.debug('Remote track of unknown participant ', participant, ' added.');
    }
    client.debug('remote track add finished, type: ', track.getType(), ' participant: ', participant);
  }


  /**
   * Handles incoming lost remote track
   * @param track JitsiTrack object
   */
  _onRemoteTrackRemove(track) {
    if (track.isLocal()) {
      return;
    }

    const participant = track.getParticipantId();
    const { client } = game.webrtc;
    client.debug('remote track type ', track.getType(), ' removed for participant ', participant);

    if (client._remoteTracks[participant] != null) {
      client._remoteTracks[participant] = client._remoteTracks[participant].filter(
        (value) => value.ssrc !== track.ssrc,
      );

      const userId = client._idCache[participant];
      const stream = client.getStreamForUser(userId);
      stream.removeTrack(track.track);

      if (userId != null) {
        game.webrtc.onUserStreamChange(userId, client.getStreamForUser(userId));
      }
    }
  }

  getStreamForUser(userId) {
    const stream = this._streams[userId];
    return stream;
  }

  async _onLocalTracks(resolve, tracks) {
    const addedTracks = [];
    const stream = new MediaStream();
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];

      track.enabled = true;
      track.track.enabled = true;
      addedTracks.push(game.webrtc.client._roomhandle.addTrack(track).then(() => {
        this.debug('local track ', track, ' added.');

        track.track.jitsiTrack = track;
        stream.addTrack(track.track);

        if (track.getType() === 'audio') {
          game.webrtc.enableStreamAudio(
            stream,
            !this.settings.users[game.user.id].muted,
          );
        } else if (track.getType() === 'video') {
          game.webrtc.enableStreamVideo(
            stream,
            !this.settings.users[game.user.id].hidden,
          );
        }
      }));
    }

    // Wait for all tracks to be added
    await Promise.all(addedTracks);

    this._streams[game.userId] = stream;

    resolve(this.getStreamForUser(game.userId));
  }

  setAudioOutput() {
    // TODO
  }

  assignStreamToVideo(stream, video) {
    this.debug('assignStreamToVideo stream:', stream, ' video:', video);

    const streamVideo = video;

    if (stream) {
      try {
        streamVideo.srcObject = stream;
      } catch (error) {
        streamVideo.src = window.URL.createObjectURL(stream);
      }

      if (game.webrtc.client.hasActiveFilter() && $(video).hasClass('local-camera')) {
        $(video).parent().append(game.webrtc.client.getFilterCanvas());
      }
    }
  }

  _onUserLeft(id) {
    this.debug('user left: ', game.webrtc.client._idCache[id]);
    game.webrtc.client._remoteTracks[id] = null;
    game.webrtc.client._usernameCache[game.webrtc.client._idCache[id]] = null;
    game.webrtc.client._streams[game.webrtc.client._idCache[id]] = null;
    game.webrtc.client._idCache[id] = null;

    game.webrtc.onUserStreamChange(game.webrtc.client._idCache[id], null);
  }

  muteStreamAudio(stream, mute) {
    stream.getAudioTracks().forEach((track) => (
      mute ? track.jitsiTrack.mute() : track.jitsiTrack.unmute()
    ));
  }

  async muteStreamVideo(stream, mute) {
    stream.getVideoTracks().forEach((track) => (
      mute ? track.jitsiTrack.mute() : track.jitsiTrack.unmute()
    ));
  }

  /* -------------------------------------------- */

  /**
   * Connection success callback
   * @private
   */
  _loginSuccess(resolve) {
    this._roomhandle = jitsirtc.initJitsiConference(this._room, {
      openBridgeChannel: true,
      startSilent: false,
      p2p: {
        enabled: false,
      },
    });
    this.debug('conference joined: ', this._roomhandle);
    this._roomhandle.setDisplayName(game.userId);

    this._roomhandle.on(JitsiMeetJS.events.conference.CONFERENCE_ERROR, this._onConferenceError);
    this._roomhandle.on(JitsiMeetJS.events.conference.TRACK_ADDED, this._onRemoteTrack);
    this._roomhandle.on(JitsiMeetJS.events.conference.TRACK_REMOVED, this._onRemoteTrackRemove);
    this._roomhandle.on(
      JitsiMeetJS.events.conference.CONFERENCE_JOINED,
      this._onConferenceJoined.bind(this, resolve),
    );

    this._roomhandle.on(JitsiMeetJS.events.conference.USER_JOINED, (id, participant) => {
      game.webrtc.client._usernameCache[participant._displayName] = id;
      game.webrtc.client._idCache[id] = participant._displayName;
      game.webrtc.client._remoteTracks[id] = [];
      game.webrtc.client._streams[participant._displayName] = new MediaStream();
      this.debug('user joined: ', participant._displayName);
    });

    this._roomhandle.on(JitsiMeetJS.events.conference.USER_LEFT, this._onUserLeft.bind(this));

    this._roomhandle.join();
  }

  _onConferenceJoined(resolve) {
    this.debug('conference joined event.');
    resolve(true);
  }

  _onConferenceError(errorCode) {
    this.debug('Conference error: ', errorCode);
    this.webrtc.onError(errorCode);
  }

  /**
   * Get the list of connected streams
   * The result would be an array of objects in the form of {id, pc, local, remote}
   * where id is the user's ID, pc is the RTCPeerConnection object associated to the peer,
   * local is the local stream added to the call and remote is the remote user's stream
   *
   * @return {Array.Object}
   */
  getConnectedStreams() {
    const localStream = game.webrtc.client.getStreamForUser(game.userId);
    const remoteStreams = [];

    Object.keys(game.webrtc.client._usernameCache).forEach((userName) => {
      if (userName !== game.userId) {
        remoteStreams.push({
          id: userName,
          local: localStream,
          remote: game.webrtc.client.getStreamForUser(userName),
        });
      }
    });
    return remoteStreams;
  }

  /* -------------------------------------------- */

  /**
   * Connection failure callback
   * @private
   */
  _loginFailure(resolve, errorCode, message) {
    this.debug('Login ERROR ', errorCode, message);
    this.webrtc.onError(message);
    resolve(false);
  }

  /* -------------------------------------------- */

  /**
   * Disconnect from the signaling server, any existing calls will be terminated.
   * This is also called whenever the server configuration is changed.
   *
   * @return {Promise.boolean}       Returns success/failure to connect
   */
  async disconnect() {
    if (jitsirtc) {
      return new Promise((resolve) => {
        jitsirtc.removeEventListener(
          JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED,
          this._loginSuccess.bind(this, resolve),
        );
        jitsirtc.removeEventListener(
          JitsiMeetJS.events.connection.CONNECTION_FAILED,
          this._loginFailure.bind(this, resolve),
        );
        jitsirtc.removeEventListener(
          JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED,
          this._onDisconnect.bind(this),
        );

        jitsirtc.disconnect();
      });
    }

    return null;
  }

  async initLocalStream(audioSrc, videoSrc) {
    const videoEffects = await game.webrtc.client.getVideoFilter();
    return new Promise((resolve) => {
      const withAudio = this._withAudio && audioSrc;
      const withVideo = this._withVideo && videoSrc;
      const localtracks = game.webrtc.client.getLocalTracks();

      let audioFound = false;
      let videoFound = false;

      for (let i = 0; i < localtracks.length; i += 1) {
        const track = localtracks[i];
        if (track.getType() === 'audio') {
          audioFound = true;
          if (!withAudio) {
            this.debug('Audio track dispose');
            track.dispose();
          }
        }
        if (track.getType() === 'video') {
          videoFound = true;
          if (!withVideo) {
            this.debug('Video track dispose');
            track.dispose();
          }
        }
      }

      const devlist = [];
      if (withAudio && !audioFound) devlist.push('audio');
      if (withVideo && !videoFound) devlist.push('video');
      this.debug('Device list for createLocalTracks: ', devlist);

      if (devlist.length > 0) {
        JitsiMeetJS.createLocalTracks({
          devices: devlist,
          resolution: 240,
          disableSimulcast: false,
          cameraDeviceId: videoSrc,
          micDeviceId: audioSrc,
          effects: videoEffects,
          constraints: {
            video: {
              aspectRatio: 4 / 3,
              height: {
                ideal: 240,
                max: 480,
                min: 120,
              },
              width: {
                ideal: 320,
                max: 640,
                min: 160,
              },

            },
          },
        })
          .then(this._onLocalTracks.bind(this, resolve))
          .catch((error) => {
            throw error;
          });
      } else {
        resolve(this.getStreamForUser(game.userId));
      }
    });
  }


  async closeLocalStream() {
    // TODO
  }

  /* -------------------------------------------- */
  /*  Device Discovery                            */
  /* -------------------------------------------- */

  /**
   * Get the list of available video sources.
   * The expected result is an object with the device id as key and its human-readable label as
   * value.
   * @return {Promise.Object}
   */
  async getVideoSources() {
    return new Promise((resolve) => {
      try {
        JitsiMeetJS.mediaDevices.enumerateDevices((list) => {
          resolve(this._deviceInfoToObject(list, 'videoinput'));
        });
      } catch (err) {
        resolve({});
      }
    });
  }

  /* -------------------------------------------- */

  /**
   * Get the list of available audio sources.
   * The expected result is an object with the device id as key and its human-readable label as
   * value.
   * @return {Promise.Object}
   */
  async getAudioSources() {
    return new Promise((resolve) => {
      try {
        JitsiMeetJS.mediaDevices.enumerateDevices((list) => resolve(this._deviceInfoToObject(list, 'audioinput')));
      } catch (err) {
        resolve({});
      }
    });
  }

  /* -------------------------------------------- */

  /**
   * Get the list of available audio output devices
   * The expected result is an object with the device id as key and its human-readable label as
   * value
   *
   * Note: This feature is not supported by Firefox by default as it depends on the enumerateDevices
   * API which doesn't list output devices on Firefox 63+ unless the media.setsinkid.enabled
   * settings is enabled.
   * See https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices
   *
   * @return {Promise.Object}
   */
  async getAudioSinks() {
    return new Promise((resolve) => {
      try {
        JitsiMeetJS.mediaDevices.enumerateDevices((list) => resolve(this._deviceInfoToObject(list, 'audiooutput')));
      } catch (err) {
        resolve({});
      }
    });
  }

  /**
   * Transform the device info array from jitsirtc into an object with {id: label} keys
   * @param {Array} list    The list of devices
   * @private
   */
  _deviceInfoToObject(list, kind) {
    const obj = {};
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].kind === kind) {
        obj[list[i].deviceId] = list[i].label || game.i18n.localize('WEBRTC.UnknownDevice');
      }
    }

    return obj;
  }


  /* -------------------------------------------- */

  /**
   * Generic error callback.
   * Filter out bad ice candidate errors since they can happen often for various reasons and
   * reporting them can only serve to confuse players.
   * @private
   */
  _onError({
    errorCode,
    errorText,
  }) {
    this.debug('Error : ', { errorCode, errorText });

    game.webrtc.onError(errorText);
  }

  /* -------------------------------------------- */

  /**
   * Called when the connection to the signaling server is lost
   * @private
   */
  _onDisconnect(...args) {
    this.debug('Disconnected', args);
    game.webrtc.onDisconnect();
  }


  /* -------------------------------------------- */

  /**
   * Notify of settings changes
   * This can be used to act according
   * @param {Object} changed     Object consisting of the changed settings in the form {key: value}
   */
  onSettingsChanged() {

    /* TODO
     */
  }
}

Hooks.on('init', () => {
  CONFIG.WebRTC.clientClass = JitsiRTCClient;
  CONFIG.debug.avclient = true;

  game.settings.register('jitsiwebrtc', 'mucUrl', {
    name: 'Jitsi MUC URL',
    hint: 'config["hosts"]["muc"] in jitsi-meet config.js',
    default: '',
    scope: 'world',
    type: String,
    config: true,
    onChange: () => window.location.reload(),
  });
  game.settings.register('jitsiwebrtc', 'focusUrl', {
    name: 'Jitsi Focus URL',
    hint: 'config["hosts"]["focus"] in jitsi-meet config.js',
    default: '',
    scope: 'world',
    type: String,
    config: true,
    onChange: () => window.location.reload(),
  });
  game.settings.register('jitsiwebrtc', 'boshUrl', {
    name: 'Jitsi Bosh URL',
    hint: 'config["bosh"] in jitsi-meet config.js',
    default: '',
    scope: 'world',
    type: String,
    config: true,
    onChange: () => window.location.reload(),
  });
});

Hooks.on('setup', () => {
  WebRTC.prototype._pttBroadcast = function _pttBroadcast(stream, broadcast) {
    this._broadcastingAudio = broadcast;
    ui.webrtc.setUserIsSpeaking(game.user.id, this._broadcastingAudio);
    this.broadcastMicrophone(!this.settings.users[game.user.id].muted && this._broadcastingAudio);
  };

  /**
   * Checks if a stream has any audio tracks enabled
   * @param {MediaStream} stream    The stream to check
   * @return {Boolean}
   */
  WebRTC.prototype.isStreamAudioEnabled = function isStreamAudioEnabled(stream) {
    if (stream === this.client.getStreamForUser(game.user.id)) {
      return !this.settings.users[game.user.id].muted;
    }

    const tracks = stream ? stream.getAudioTracks() : [];
    return tracks.some((t) => t.enabled);
  };
});

Hooks.on('ready', () => {
  let roomid = game.webrtc.settings.getWorldSetting('server.room');
  if (roomid === '') {
    roomid = `fvtt${10000000 + Math.floor((Math.random() * 10000000) + 1)}`;
    game.webrtc.settings.setWorldSetting('server.room', roomid);
  }
  Hooks.callAll('webrtcSetVideoFilter');
});
