  const apiPath  = 'https://director.millicast.com/api/director/subscribe';
  const turnUrl  = 'https://turn.millicast.com/webrtc/_turn';

  let params     = new URLSearchParams(document.location.search.substring(1));
  let accountId  = params.get('account');
  let streamName = params.get('id');
  let subToken = params.get('token');// SubscribingToken - placed here for ease of testing, should come from secure location. (php/nodejs)

  console.log('Millicast Viewer Stream: ', streamName);

  //Millicast required info.
  let url;// path to Millicast Server - Returned from API
  let jwt;// authorization token - Returned from API

  let pc;//peer connection
  let ws;//live websocket
  let reconn = false;// flag for reconnection

  //Ice Servers:
  let iceServers = [];

  //show user count
  let showUserCount = true;

  function toggleMute(){
  player.muted = !player.muted;
  if (!player.muted){
  audioBtn.style.visibility = 'hidden';
  //player.play(); 
  }
}

  function connect() {
    reconn = false;
    if (!url) {
      showMsg('Authenticating...');
      updateMillicastAuth()
        .then(d => {
          connect();
        })
        .catch(e => {
          console.log('api error: ', e);
          showMsg(e.status+': '+e.data.message);
          // alert("Error: The API encountered an error ", e);
        });
      return;
    }
    showMsg('Connecting...');

    console.log('connecting to: ', url);
    //create Peer connection object
    let conf = {
      iceServers:    iceServers,
      // sdpSemantics : "unified-plan",
      rtcpMuxPolicy: "require",
      bundlePolicy:  "max-bundle"
    };
    // console.log('config: ', conf);
    pc     = new RTCPeerConnection(conf);
    //Listen for track once it starts playing.
    pc.ontrack = function (event) {
      console.debug("pc::onAddStream", event);
      //Play it
      let vidWin = document.getElementsByTagName('video')[0];
      if (vidWin) {
        vidWin.srcObject = event.streams[0];
        vidWin.controls  = true;
      }
    };
    pc.onconnectionstatechange = function(e) {
      console.log('PC state:',pc.connectionState);
      switch(pc.connectionState) {
        case "connected":

          if(!ws_cnt && showUserCount){
            //show user count.
            let el = document.getElementById('userCntView');
            if(window.getComputedStyle(el, null).display === 'none'){
              el.style.display = 'unset';
            }
            
            startUserCount(accountId, streamName, document.getElementById('count'));
          }

          break;
        case "disconnected":
          // stopUserCount();
        case "failed":
          break;
        case "closed":
          console.log('WS onclose ',reconn);
          // Connection closed, if reconnecting? reset and call again.
          if(reconn){
            stopUserCount();
            pc = null;
            if(!ws){
              connect();
            }
          }
          break;
      }
    }

    console.log('connecting to: ', url + '?token=' + jwt);//token
    //connect with Websockets for handshake to media server.
    ws    = new WebSocket(url + '?token=' + jwt);
    ws.onopen = function () {
      //Connect to our media server via WebRTC
      console.log('ws::onopen');
      //create a WebRTC offer to send to the media server
      let offer = pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true })
        .then(desc => {
          console.log('createOffer Success!');
          //support for stereo
          desc.sdp = desc.sdp.replace("useinbandfec=1", "useinbandfec=1; stereo=1");
          //try for multiopus (surround sound) support
          try {
            desc.sdp = setMultiopus(desc);
          } catch(e){
            console.log('create offer stereo',offer);
          }
          
          //set local description and send offer to media server via ws.
          pc.setLocalDescription(desc)
            .then(() => {
              console.log('setLocalDescription Success!');
              //set required information for media server.
              let data    = {
                streamId: accountId,//Millicast accountId
                sdp:      desc.sdp
              }
              //create payload
              let payload = {
                type:    "cmd",
                transId: 0,
                name:    'view',
                data:    data
              }
              console.log('send ', payload);
              ws.send(JSON.stringify(payload));
            })
            .catch(e => {
              console.log('setLocalDescription failed: ', e);
              showMsg(e.status+': '+e.data.message);
            })
        }).catch(e => {
          console.log('createOffer Failed: ', e)
          showMsg(e.status+': '+e.data.message);
        });
    }
    ws.onclose = function () {
      console.log('WS onclose ',reconn);
      if(reconn){
        ws = null;
        if(!pc){
          setTimeout(connect(),700);
        } else {
          console.log('close PC ',pc);
          pc.close();
          pc = null;
          setTimeout(connect(),700);
        }
      }
    }
    ws.addEventListener('message', evt => {
      console.log('ws::message', evt);
      let msg = JSON.parse(evt.data);
      switch (msg.type) {
        //Handle counter response coming from the Media Server.
        case "response":
          let data   = msg.data;
          let remotesdp = data.sdp;

          /* handle older versions of Safari */
          if (remotesdp && remotesdp.indexOf('\na=extmap-allow-mixed') !== -1) {
            remotesdp = remotesdp.split('\n').filter(function (line) {
              return line.trim() !== 'a=extmap-allow-mixed';
            }).join('\n');
            console.log('trimed a=extmap-allow-mixed - sdp \n',remotesdp);
          }
          let answer = new RTCSessionDescription({
                                                   type: 'answer',
                                                   sdp:  remotesdp
                                                 });

          pc.setRemoteDescription(answer)
            .then(d => {
              console.log('setRemoteDescription  Success! ');
              showMsg('');
            })
            .catch(e => {
              console.log('setRemoteDescription failed: ', e);
              showMsg(e.status+': '+e.data.message);
            });
          break;
        case "event":
          if(msg.name === 'inactive'){
            console.log('Video Inactive');
            showMsg('Stream inactive, please stand by...');
          } else if(msg.name === 'active'){
            console.log('Video Active');
            showMsg('');//clear message
          } else if( msg.name === 'stopped'){
            console.log('Video Stopped');
            showMsg('Stream is not available.');
            //todo - reset video object, re-instate handshake. 
            let vidWin = document.getElementsByTagName('video')[0];
            if (vidWin) {
              vidWin.pause();
              // vidWin.removeAttribute('src'); // empty source
              vidWin.src = '';
              vidWin.load();
              // connect();
              doReconnect();
            }
          }
          break;
      }
    })
  
  }

  function doReconnect(){
    reconn = true;
    url = null;
    ws.close();
    //pc.close();
    // setTimeout(connect(),700);
  }

  // Gets ice servers.
  function getICEServers() {
    return new Promise((resolve, reject) => {
      let xhr                = new XMLHttpRequest();
      xhr.onreadystatechange = function (evt) {
        if (xhr.readyState == 4) {
          let res = JSON.parse(xhr.responseText), a;
          console.log('getICEServers::status:', xhr.status, ' response: ', xhr.responseText);
          switch (xhr.status) {
            case 200:
              //returns array.
              if (res.s !== 'ok') {
                a = [];
                //failed to get ice servers, resolve anyway to connect w/ out.
                resolve(a);
                return
              }
              let list = res.v.iceServers;
              a        = [];
              //call returns old format, this updates URL to URLS in credentials path.
              list.forEach(cred => {
                let v = cred.url;
                if (!!v) {
                  cred.urls = v;
                  delete cred.url;
                }
                a.push(cred);
                //console.log('cred:',cred);
              });
              console.log('ice: ', a);
              resolve(a);
              break;
            default:
              a = [];
              //reject(xhr.responseText);
              //failed to get ice servers, resolve anyway to connect w/ out.
              resolve(a);
              break;
          }
        }
      }
      xhr.open("PUT", turnUrl, true);
      xhr.send();
    })
  }

  // gets server path and auth token.
  function updateMillicastAuth() {
    console.log('updateMillicastAuth at: ' + apiPath + ' for:', streamName, ' accountId:', accountId);
    return new Promise((resolve, reject) => {
      let xhr                = new XMLHttpRequest();
      xhr.onreadystatechange = function (evt) {
        if (xhr.readyState == 4) {
          let res = JSON.parse(xhr.responseText);
          console.log('res: ', res);
          console.log('status:', xhr.status, ' response: ', xhr.responseText);
          switch (xhr.status) {
            case 200:
              if( res.status !== 'fail' ){
                let d = res.data;
                jwt   = d.jwt;
                url   = d.urls[0];
                resolve(d);
              }
              break;
            default:
              reject(res);
          }
        }
      }
      xhr.open("POST", apiPath, true);
      //apply subscribe token if available.
      if (subToken) {
        xhr.setRequestHeader('Authorization', `Bearer ${subToken}`);
        console.log('sub token applied');
      }
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify({streamAccountId: accountId, streamName: streamName, unauthorizedSubscribe: true}));
    });
  }

  //support for multiopus
  function setMultiopus(offer){
    ///// currently chrome only
    let isChromium = window.chrome;
    let winNav = window.navigator;
    let vendorName = winNav.vendor;
    let agent = winNav.userAgent.toLowerCase();
    let isOpera = typeof window.opr !== "undefined";
    let isIEedge = agent.indexOf("edge") > -1;
    let isEdgium = agent.indexOf("edg") > -1;
    let isIOSChrome = agent.match("crios");
    
    let isChrome = false;
    if (isIOSChrome) {
    } else if( isChromium !== null && typeof isChromium !== "undefined" && 
                vendorName === "Google Inc." && isOpera === false && 
                isIEedge === false && isEdgium === false) {
      // is Google Chrome
      isChrome = true;
    }

    console.log('isChrome: ',isChrome);
    if(isChrome){ 
      // console.log('agent: ',navigator.userAgent);
      //Find the audio m-line
      const res = /m=audio 9 UDP\/TLS\/RTP\/SAVPF (.*)\r\n/.exec(offer.sdp);
      //Get audio line
      const audio = res[0];
      //Get free payload number for multiopus
      const pt  = Math.max(...res[1].split(" ").map( Number )) + 1;
      //Add multiopus 
      const multiopus = audio.replace("\r\n"," ") + pt + "\r\n" + 
        "a=rtpmap:" + pt + " multiopus/48000/6\r\n" +
        "a=fmtp:" + pt + " channel_mapping=0,4,1,2,3,5;coupled_streams=2;minptime=10;num_streams=4;useinbandfec=1\r\n";
      //Change sdp
      offer.sdp = offer.sdp.replace(audio,multiopus);
      console.log('create multi-opus offer',offer);
    } else {
      console.log('no multi-opus support');
    }
    return offer.sdp;
  }

  function showMsg(s){
    vidMsg.innerText = s;
  }

  function ready() {
    //vidMsg = document.getElementById('msgOverlay');
    //let v = document.getElementsByTagName('video')[0];
    //if (v) {
     // v.addEventListener("click", evt => {
       // v.play();
     // });
    //}
    //connect();
    // get a list of Xirsys ice servers.
    getICEServers()
      .then(list => {
        iceServers = list;
        //ready to connect.
        connect();
      });
  }

  if (document.attachEvent ? document.readyState === "complete" : document.readyState !== "loading") {
    ready();
  } else {
    document.addEventListener('DOMContentLoaded', ready);
  }
var wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  v.srcObject = await navigator.mediaDevices.getUserMedia({player: true});
  while (true) {
    console.log(v.currentTime);
    await wait(100);
  }
})().catch(e => console.log(e));







