/* 말씀읽기APP — Firebase 로그인/진도저장 + bible.json
   + 안드로이드 최적화 음성매칭
   + 마이크는 버튼으로만 ON/OFF
   + 절 완료시 절 버튼 색, 장 모두 완료시 장 버튼 색
   + 절 자동이동/장 자동이동(성공 처리)
   + "해당절읽음" 버튼 지원
   + 마이크 ON일 때 음성모드 변경 금지(라디오 없을 시 자동 무시)
*/
(() => {
  // ---------- PWA ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" })
        .then(reg => console.log("[SW] registered:", reg.scope))
        .catch(err => console.warn("[SW] register failed:", err));
    });
  }

  // ---------- Firebase ----------
  let auth, db, user;
  function initFirebase() {
    if (!window.firebaseConfig || typeof firebase === "undefined") {
      console.error("[Firebase] SDK/config 누락");
      return;
    }
    firebase.initializeApp(window.firebaseConfig);
    auth = firebase.auth();
    db   = firebase.firestore();
    console.log("[Firebase] 초기화 OK");
  }
  initFirebase();

  // ---------- Screens ----------
  const scrLogin = document.getElementById("screen-login");
  const scrApp   = document.getElementById("screen-app");
  function showScreen(name) {
    if (name === "login") { scrLogin?.classList.add("show"); scrApp?.classList.remove("show"); }
    else { scrApp?.classList.add("show"); scrLogin?.classList.remove("show"); }
  }

  // ---------- DOM ----------
  const els = {
    email: document.getElementById("email"),
    password: document.getElementById("password"),
    displayName: document.getElementById("displayName"),
    nickname: document.getElementById("nickname"),
    btnLogin: document.getElementById("btnLogin"),
    btnSignup: document.getElementById("btnSignup"),
    signedIn: document.getElementById("signedIn"),
    userName: document.getElementById("userName"),
    userPhoto: document.getElementById("userPhoto"),
    btnSignOut: document.getElementById("btnSignOut"),
    bookSelect: document.getElementById("bookSelect"),
    chapterGrid: document.getElementById("chapterGrid"),
    verseGrid: document.getElementById("verseGrid"),
    verseText: document.getElementById("verseText"),
    locLabel: document.getElementById("locLabel"),
    verseCount: document.getElementById("verseCount"),
    myStats: document.getElementById("myStats"),
    leaderList: document.getElementById("leaderList"),
    matrixModal: document.getElementById("matrixModal"),
    matrixWrap: document.getElementById("matrixWrap"),
    btnCloseMatrix: document.getElementById("btnCloseMatrix"),
    btnOpenMatrix: document.getElementById("btnOpenMatrix"),
    btnPrevVerse: document.getElementById("btnPrevVerse"),
    btnNextVerse: document.getElementById("btnNextVerse"),
    btnToggleMic: document.getElementById("btnToggleMic"),
    btnMarkRead: document.getElementById("btnMarkRead"),
    listenHint: document.getElementById("listenHint"),
    autoAdvance: document.getElementById("autoAdvance"),
    micBar: document.getElementById("micBar"),
    micDb: document.getElementById("micDb"),
  };

  // 모달이 닫혀있을 때는 클릭 차단
  if (els.matrixModal) els.matrixModal.style.pointerEvents = "none";

  // ---------- State ----------
  const BOOKS = window.BOOKS || [];
  const getBookByKo = (ko) => BOOKS.find(b => b.ko === ko);
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const state = {
    bible: null, currentBookKo: null, currentChapter: null,
    verses: [], currentVerseIdx: 0,
    listening:false, recog:null,
    progress:{}, myStats:{versesRead:0,chaptersRead:0,last:{bookKo:null,chapter:null,verse:0}},
    ignoreUntilTs: 0, paintedPrefix: 0,
    verseDoneMap: {},
    // 하이라이트 정합성용 캐시
    charCumJamo: [],    // 각 화면 글자까지의 누적 자모 길이
    charJamoLens: [],   // 각 화면 글자의 자모 기여 길이
    // 누적 음성(자모) 버퍼
    heardJ: "",
    // 자동 이동 제어
    _advancing:false,
    // 🎚️ 약간 늦게 칠하기용 타이머
    paintTimer: null,
    pendingPaint: 0
  };

  // === DEBUG 툴 ===
  const DEBUG = localStorage.getItem("debugMatch")==="1";
  let _dbgBuf = [];
  function dbg(...args){
    if (!DEBUG) return;
    const line = args.map(a => (typeof a==="object" ? JSON.stringify(a) : String(a))).join(" ");
    _dbgBuf.push(line); if (_dbgBuf.length>300) _dbgBuf.shift();
    console.log("[MATCH]", ...args);
    const box = document.getElementById("debugPanel");
    if (box) box.textContent = _dbgBuf.slice(-120).join("\n");
  }
  function dbgPanelInit(){
    if (!DEBUG) return;
    if (document.getElementById("debugPanel")) return;
    const box = document.createElement("pre");
    box.id = "debugPanel";
    box.style.position="fixed";
    box.style.right="8px";
    box.style.bottom="8px";
    box.style.maxWidth="46vw";
    box.style.maxHeight="40vh";
    box.style.overflow="auto";
    box.style.background="rgba(0,0,0,.75)";
    box.style.color="#c9f7d6";
    box.style.font="12px/1.3 monospace";
    box.style.padding="8px 10px";
    box.style.border="1px solid #2a2a2a";
    box.style.borderRadius="8px";
    box.style.zIndex="99999";
    box.textContent = "🔎 음성매칭 디버그 패널 (localStorage.debugMatch=1)\n";
    document.body.appendChild(box);
  }
  window.addEventListener("load", dbgPanelInit);

  // ==== 매칭 엄격도: '엄격' | '보통' | '관대' (기본=보통) ====
  let MATCH_STRICTNESS = localStorage.getItem("matchStrictness") || "보통";
  window.setMatchStrictness = function(level){
    if(!["엄격","보통","관대"].includes(level)) return;
    MATCH_STRICTNESS = level;
    localStorage.setItem("matchStrictness", level);
    const hint = document.getElementById("listenHint");
    if (hint) hint.textContent = `음성매칭 엄격도: ${level}`;
    // 라디오 UI 동기화
    document.querySelectorAll('input[name=matchStrict]').forEach(r=>{
      r.checked = (r.value === level);
    });
  };
  function needThresholdByLen(len){
    const base = (len<=30?0.80:(len<=60?0.78:0.75));
    const delta = (MATCH_STRICTNESS==="엄격"? +0.04 : MATCH_STRICTNESS==="관대"? -0.04 : 0);
    return Math.max(0.65, Math.min(0.92, base + delta));
  }
  function costsByStrictness(){
    if (MATCH_STRICTNESS==="엄격") return { subNear:0.38, subFar:1.00, del:0.60, ins:0.60 };
    if (MATCH_STRICTNESS==="관대") return { subNear:0.28, subFar:0.88, del:0.52, ins:0.52 };
    return { subNear:0.35, subFar:1.00, del:0.55, ins:0.55 };
  }
  function initStrictnessUI(){
    const radios = document.querySelectorAll('input[name=matchStrict]');
    if (!radios.length) return;
    radios.forEach(r=>{
      r.checked = (r.value === MATCH_STRICTNESS);
      r.addEventListener('change', ()=>{
        if (r.checked) window.setMatchStrictness(r.value);
      });
    });
    const hint = document.getElementById("listenHint");
    if (hint) hint.textContent = `음성매칭 엄격도: ${MATCH_STRICTNESS}`;
  }

  // ---------- bible.json ----------
  async function loadBible() {
    try {
      const res = await fetch("./bible.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("bible.json not found");
      state.bible = await res.json();
    } catch (e) {
      console.error("[bible.json] 로딩 실패:", e);
      els.verseText && (els.verseText.textContent = "루트에 bible.json 파일이 필요합니다.");
    }
  }
  loadBible();
  initStrictnessUI(); // 👈 엄격도 UI 초기화

  // ---------- Auth UX ----------
  function mapAuthError(e) {
    const code = e?.code || "";
    if (code.includes("invalid-email")) return "이메일 형식이 올바르지 않습니다.";
    if (code.includes("email-already-in-use")) return "이미 가입된 이메일입니다. 로그인하세요.";
    if (code.includes("weak-password")) return "비밀번호를 6자 이상으로 입력하세요.";
    if (code.includes("operation-not-allowed")) return "이메일/비밀번호 로그인이 비활성화되어 있습니다. 콘솔에서 활성화해주세요.";
    if (code.includes("network-request-failed")) return "네트워크 오류가 발생했습니다. 인터넷 연결을 확인하세요.";
    return e?.message || "알 수 없는 오류가 발생했습니다.";
  }
  async function safeEnsureUserDoc(u, opts={}) {
    try { await ensureUserDoc(u, opts); } catch (e){ console.warn("[ensureUserDoc] 실패:", e); }
  }
  let busy=false;
  async function withBusy(btn, fn){
    if(busy) return;
    busy=true;
    const orig = btn?.textContent;
    if(btn){ btn.disabled=true; btn.textContent="처리 중…"; }
    try{ await fn(); } finally { busy=false; if(btn){ btn.disabled=false; btn.textContent=orig; } }
  }

  // ---------- 회원가입 / 로그인 / 로그아웃 ----------
  els.btnSignup?.addEventListener("click", () => withBusy(els.btnSignup, async () => {
    const email = (els.email.value || "").trim();
    const pw    = (els.password.value || "").trim();
    const name  = (els.displayName.value || "").trim();
    const nick  = (els.nickname?.value || "").trim();
    if (!email || !pw) { alert("이메일/비밀번호를 입력하세요."); return; }

    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pw);
      user = cred.user;
      if (name) { await user.updateProfile({ displayName: name }); }
      await safeEnsureUserDoc(user, { nickname: nick });
    } catch (e) {
      console.error(e);
      alert("회원가입 실패: " + mapAuthError(e));
    }
  }));

  els.btnLogin?.addEventListener("click", () => withBusy(els.btnLogin, async () => {
    const email = (els.email.value || "").trim();
    const pw    = (els.password.value || "").trim();
    const name  = (els.displayName.value || "").trim();
    const nick  = (els.nickname?.value || "").trim();
    if (!email || !pw) { alert("이메일/비밀번호를 입력하세요."); return; }

    try {
      const cred = await auth.signInWithEmailAndPassword(email, pw);
      user = cred.user;
      if (name) { await user.updateProfile({ displayName: name }); }
      await safeEnsureUserDoc(user, { nickname: nick });
    } catch (e) {
      console.error(e);
      alert("로그인 실패: " + mapAuthError(e));
    }
  }));

  els.btnSignOut?.addEventListener("click", () => auth?.signOut());

  auth?.onAuthStateChanged(async (u) => {
    user = u;
    if (!u) { showScreen("login"); clearAppUI(); return; }

    showScreen("app");
    els.signedIn?.classList.remove("hidden");
    els.userName && (els.userName.textContent = u.displayName || u.email || "사용자");
    if (els.userPhoto) {
      if (u.photoURL) { els.userPhoto.src = u.photoURL; els.userPhoto.classList.remove('hidden'); }
      else { els.userPhoto.classList.add('hidden'); }
    }

    try { await ensureUserDoc(u); } catch (e) {}
    try { await loadMyStats(); } catch (e) {}
    try { buildBookSelect(); } catch (e) {}
    try { loadLeaderboard(); } catch (e) {}
  });

  // ---------- Firestore helpers ----------
  async function ensureUserDoc(u, opts={}) {
    if (!db || !u) return;
    const data = {
      email: u.email || "",
      versesRead: firebase.firestore.FieldValue.increment(0),
      chaptersRead: firebase.firestore.FieldValue.increment(0),
      last: state.myStats.last || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (opts.nickname && opts.nickname.trim()) data.nickname = opts.nickname.trim();
    await db.collection("users").doc(u.uid).set(data, { merge: true });
  }

  async function loadMyStats() {
    if (!db || !user) return;
    try {
      const snap = await db.collection("users").doc(user.uid).get();
      if (snap.exists) {
        const d = snap.data();
        state.myStats.versesRead = d.versesRead || 0;
        state.myStats.chaptersRead = d.chaptersRead || 0;
        state.myStats.last = d.last || { bookKo: null, chapter: null, verse: 0 };
        els.myStats && (els.myStats.textContent =
          `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
      }
    } catch (e) {}

    const p = {};
    try {
      const qs = await db.collection("users").doc(user.uid).collection("progress").get();
      qs.forEach(doc => { p[doc.id] = { readChapters: new Set((doc.data().readChapters) || []) }; });
    } catch (e) {}
    state.progress = p;
  }

  async function saveLastPosition() {
    if (!db || !user) return;
    try {
      await db.collection("users").doc(user.uid).set({
        last: state.myStats.last,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {}
  }

  async function markChapterDone(bookId, chapter) {
    if (!state.progress[bookId]) state.progress[bookId] = { readChapters: new Set() };
    state.progress[bookId].readChapters.add(chapter);
    if (db && user) {
      try {
        await db.collection("users").doc(user.uid).collection("progress").doc(bookId)
          .set({ readChapters: Array.from(state.progress[bookId].readChapters) }, { merge: true });
        await db.collection("users").doc(user.uid)
          .set({ chaptersRead: firebase.firestore.FieldValue.increment(1),
                 updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        state.myStats.chaptersRead += 1;
        els.myStats && (els.myStats.textContent =
          `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
        buildChapterGrid();
        buildMatrix();
      } catch (e) {}
    }
  }

  async function incVersesRead(n = 1) {
    state.myStats.versesRead += n;
    els.myStats && (els.myStats.textContent =
      `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
    if (db && user) {
      try {
        await db.collection("users").doc(user.uid)
          .set({
            versesRead: firebase.firestore.FieldValue.increment(n),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
      } catch (e) {}
    }
  }

  // ---------- Book / Chapter / Verse ----------
  function clearAppUI() {
    els.bookSelect && (els.bookSelect.innerHTML = "");
    els.chapterGrid && (els.chapterGrid.innerHTML = "");
    els.verseGrid && (els.verseGrid.innerHTML = "");
    els.verseText && (els.verseText.textContent = "로그인 후 시작하세요.");
    els.leaderList && (els.leaderList.innerHTML = "");
    els.myStats && (els.myStats.textContent = "—");
    els.locLabel && (els.locLabel.textContent = "");
    els.verseCount && (els.verseCount.textContent = "");
    state.currentBookKo = null; state.currentChapter = null; state.verses = []; state.currentVerseIdx = 0;
  }

  function buildBookSelect() {
    if (!els.bookSelect) return;
    els.bookSelect.innerHTML = "";
    for (const b of BOOKS) {
      const opt = document.createElement("option");
      opt.value = b.ko; opt.textContent = b.ko;
      els.bookSelect.appendChild(opt);
    }
    const last = state.myStats?.last;
    if (last?.bookKo) {
      els.bookSelect.value = last.bookKo; state.currentBookKo = last.bookKo; buildChapterGrid();
      if (last.chapter) {
        selectChapter(last.chapter).then(() => {
          if (Number.isInteger(last.verse)) {
            state.currentVerseIdx = Math.max(0, (last.verse || 1) - 1); updateVerseText();
          }
        });
      }
    } else {
      els.bookSelect.value = BOOKS[0]?.ko || "";
      state.currentBookKo = els.bookSelect.value;
      buildChapterGrid();
    }
  }

  els.bookSelect?.addEventListener("change", () => {
    state.currentBookKo = els.bookSelect.value;
    state.currentChapter = null; state.verses = []; state.currentVerseIdx = 0;
    els.verseGrid && (els.verseGrid.innerHTML = "");
    els.verseText && (els.verseText.textContent = "장과 절을 선택하세요.");
    buildChapterGrid();
    state.myStats.last = { bookKo: state.currentBookKo, chapter: null, verse: 0 }; saveLastPosition();
  });

  // 장 버튼(원형) + 완료색 반영
  function buildChapterGrid() {
    const b = getBookByKo(state.currentBookKo);
    if (!b || !els.chapterGrid) return;
    els.chapterGrid.innerHTML = "";

    for (let i = 1; i <= b.ch; i++) {
      const btn = document.createElement("button");
      btn.type = "button"; // 폼 제출 방지
      const isDonePersist = state.progress[b.id]?.readChapters?.has(i);
      btn.className = "chip";
      btn.style.borderRadius = "9999px"; // 원형
      btn.textContent = i;

      // 세션 중 이 장의 절을 전부 완료했다면 done
      if (state.currentChapter === i) {
        const key = `${state.currentBookKo}#${i}`;
        const set = state.verseDoneMap[key];
        if (set && state.verses.length > 0 && set.size === state.verses.length) {
          btn.classList.add("done");
          btn.style.backgroundColor = "rgba(67,209,122,0.8)";
        }
      }
      if (isDonePersist) btn.classList.add("done");

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        selectChapter(i);
      });
      if (state.currentChapter === i) btn.classList.add("active");
      els.chapterGrid.appendChild(btn);
    }
  }

  // 장 버튼 위임 클릭(동적 갱신/리스너 누락 대비)
  els.chapterGrid?.addEventListener("click", (e) => {
    const btn = e.target?.closest("button.chip");
    if (!btn || !els.chapterGrid.contains(btn)) return;
    const n = parseInt(btn.textContent, 10);
    if (Number.isFinite(n)) {
      e.preventDefault();
      e.stopPropagation();
      selectChapter(n);
    }
  });

  function keyForChapter(){ return `${state.currentBookKo}#${state.currentChapter}`; }

  // 절 버튼(원형) + 완료색 반영
  function buildVerseGrid() {
    if (!els.verseGrid) return;
    els.verseGrid.innerHTML = "";
    const key = keyForChapter();
    const doneSet = state.verseDoneMap[key] || new Set();

    for (let i = 1; i <= state.verses.length; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.style.borderRadius = "9999px";
      btn.textContent = i;

      if (doneSet.has(i)) {
        btn.classList.add("readok");
        btn.style.backgroundColor = "rgba(67,209,122,0.6)";
      }

      btn.addEventListener("click", () => {
        state.currentVerseIdx = i - 1; updateVerseText();
        state.myStats.last.verse = i; saveLastPosition();
      });
      if (state.currentVerseIdx === i - 1) btn.classList.add("active");
      els.verseGrid.appendChild(btn);
    }
  }

  // ---------- 표시/매칭 ----------
  // 자모 누적 길이 맵 — normalizeToJamo 규칙과 동일하게 길이 계산(문장부호/공백은 0)
  function buildCharToJamoCumMap(str){
    const jamoLens = [];
    const cum = [0];

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const rawJamo = decomposeJamo(ch).normalize("NFKC");
      const cleaned = rawJamo.replace(/[^\p{L}\p{N}]/gu, ""); // 문장부호/공백 제외
      const len = cleaned.length;
      jamoLens.push(len);
      cum.push(cum[cum.length - 1] + len);
    }

    state.charJamoLens = jamoLens;
    return cum;
  }

  // updateVerseText
  function updateVerseText() {
    const v = state.verses[state.currentVerseIdx] || "";
    state.paintedPrefix = 0;
    state.heardJ = "";            // 절 바뀔 때 누적 음성 버퍼 초기화
    state.ignoreUntilTs = 0;
    state._advancing = false;     // 자동 넘어가기 락 해제
    if (state.paintTimer) { clearTimeout(state.paintTimer); state.paintTimer=null; }

    // 현재 절의 자모 문자열과 누적 자모 길이 맵 캐시
    state.targetJ = normalizeToJamo(v, false);
    state.charCumJamo = buildCharToJamoCumMap(v);

    els.locLabel && (els.locLabel.textContent =
      `${state.currentBookKo} ${state.currentChapter}장 ${state.currentVerseIdx + 1}절`);
    if (els.verseText) {
      els.verseText.innerHTML = "";
      for (let i = 0; i < v.length; i++) {
        const s = document.createElement("span");
        s.textContent = v[i];
        // 🎨 글자색만 변경할 것이므로 초기에는 기본색
        s.style.color = ""; // reset
        els.verseText.appendChild(s);
      }
    }
    els.verseCount && (els.verseCount.textContent =
      `(${state.verses.length}절 중 ${state.currentVerseIdx + 1}절)`);
    if (els.verseGrid) {
      [...els.verseGrid.children].forEach((btn, idx) =>
        btn.classList.toggle("active", idx===state.currentVerseIdx));
    }
  }

  // 🎨 글자색만 바꾸는 칠하기
  function paintRead(prefixJamoLen){
    if (!els.verseText) return;
    const spans = els.verseText.childNodes;
    const cum   = state.charCumJamo || [];
    const lens  = state.charJamoLens || [];

    let k = 0;
    while (k < cum.length && cum[k] <= prefixJamoLen) k++;
    let charCount = Math.max(0, k - 1);

    if (prefixJamoLen === 0) {
      const firstNonZero = lens.findIndex(v => v > 0);
      if (firstNonZero > 0) charCount = 0;
    }

    for (let i=0;i<spans.length;i++){
      // 읽힌 글자: 초록색(#43d17a), 나머지 기본
      spans[i].style.color = (i < charCount) ? "#43d17a" : "";
      // 배경 등 기존 클래스는 사용하지 않음
      spans[i].classList?.remove("read");
    }
  }

  // ⏱️ 살짝 늦게 칠하기(음성보다 앞서지 않도록 140ms 지연)
  function schedulePaint(nextPrefix){
    state.pendingPaint = Math.max(state.pendingPaint, nextPrefix);
    if (state.paintTimer) clearTimeout(state.paintTimer);
    state.paintTimer = setTimeout(() => {
      const target = Math.max(state.paintedPrefix, state.pendingPaint);
      paintRead(target);
      state.paintedPrefix = target;
      state.pendingPaint = 0;
      state.paintTimer = null;
    }, 140);
  }

  function markVerseAsDone(verseIndex1Based) {
    const key = keyForChapter();
    if (!state.verseDoneMap[key]) state.verseDoneMap[key] = new Set();
    state.verseDoneMap[key].add(verseIndex1Based);

    // 절 버튼 색 갱신
    if (els.verseGrid) {
      const btn = els.verseGrid.children[verseIndex1Based - 1];
      if (btn) {
        btn.classList.add("readok");
        btn.style.backgroundColor = "rgba(67,209,122,0.6)";
      }
    }

    // 모든 절 완료되었으면 현재 장 버튼도 done
    if (state.verses.length > 0 && state.verseDoneMap[key].size === state.verses.length) {
      if (els.chapterGrid) {
        const idx = (state.currentChapter - 1);
        const chBtn = els.chapterGrid.children[idx];
        if (chBtn) {
          chBtn.classList.add("done");
          chBtn.style.backgroundColor = "rgba(67,209,122,0.8)";
        }
      }
    }
  }

  // ---------- 마이크 예열 ----------
  let primeStream;
  async function primeMicrophone() {
    if (primeStream && primeStream.getTracks().some(t=>t.readyState==="live")) return primeStream;
    try {
      primeStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate:   { ideal: 48000 },
          sampleSize:   { ideal: 16 },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl:  { ideal: true }
        },
        video: false
      });
      if (window.AudioContext || window.webkitAudioContext) {
        try {
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          if (ac.state === "suspended") await ac.resume();
          const src = ac.createMediaStreamSource(primeStream);
          const g = ac.createGain(); src.connect(g);
          await new Promise(r => setTimeout(r, 20));
          ac.close();
        } catch(_) {}
      }
      return primeStream;
    } catch (e) {
      console.warn("[PrimeMic] 실패:", e);
      return null;
    }
  }
  function releasePrimeMic() {
    try { if (primeStream) primeStream.getTracks().forEach(t=>t.stop()); } catch(_) {}
    primeStream = null;
  }

  // ---------- 한글 정규화/자모 ----------
  const CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
  const JONG = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  const S_BASE=0xAC00, L_COUNT=19, V_COUNT=21, T_COUNT=28, N_COUNT=V_COUNT*T_COUNT, S_COUNT=L_COUNT*N_COUNT;

  function decomposeJamo(s){
    const out=[];
    for (const ch of (s||"")){
      const code = ch.codePointAt(0);
      const sIndex = code - S_BASE;
      if (sIndex>=0 && sIndex<S_COUNT){
        const L = Math.floor(sIndex/N_COUNT);
        const V = Math.floor((sIndex%N_COUNT)/T_COUNT);
        const T = sIndex%T_COUNT;
        out.push(CHO[L], JUNG[V]); if (T) out.push(JONG[T]);
      } else out.push(ch);
    }
    return out.join("");
  }

  const NUM_KO = {"영":0,"공":0,"하나":1,"한":1,"둘":2,"두":2,"셋":3,"세":3,"넷":4,"네":4,"다섯":5,"여섯":6,"일곱":7,"여덟":8,"아홉":9,"열":10};
  function normalizeKoreanNumbers(s){
    return s
      .replace(/(열|한\s*십|일\s*십)/g,"십")
      .replace(/(한|일)\s*십/g,"십")
      .replace(/(둘|이)\s*십/g,"이십")
      .replace(/(셋|삼)\s*십/g,"삼십")
      .replace(/(넷|사)\s*십/g,"사십")
      .replace(/(다섯|오)\s*십/g,"오십")
      .replace(/(여섯|육)\s*십/g,"육십")
      .replace(/(일곱|칠)\s*십/g,"칠십")
      .replace(/(여덟|팔)\s*십/g,"팔십")
      .replace(/(아홉|구)\s*십/g,"구십")
      .replace(/십\s*(한|일)/g,"11").replace(/십\s*(둘|이)/g,"12")
      .replace(/십\s*(셋|삼)/g,"13").replace(/십\s*(넷|사)/g,"14")
      .replace(/십\s*(다섯|오)/g,"15").replace(/십\s*(여섯|육)/g,"16")
      .replace(/십\s*(일곱|칠)/g,"17").replace(/십\s*(여덟|팔)/g,"18")
      .replace(/십\s*(아홉|구)/g,"19")
      .replace(/^\s*십\s*$/g,"10");
  }

  const USE_PRONUN_HEUR = true; // '의'≈'에' 등
  function normalizeToJamo(s, forSpoken=false){
    let t = (s||"").normalize("NFKC").replace(/[“”‘’"'\u200B-\u200D`´^~]/g,"").toLowerCase();
    t = normalizeKoreanNumbers(t);
    if (forSpoken && USE_PRONUN_HEUR) t = t.replace(/의/g,"에");
    t = t.replace(/[^\p{L}\p{N} ]/gu," ").replace(/\s+/g," ").trim();
    return decomposeJamo(t).replace(/\s+/g,"");
  }

  // ---------- 매칭: (추가) 징검다리 방식 ----------
  function near(a,b){
    return a===b || new Set([
      "ㅐ,ㅔ","ㅔ,ㅐ","ㅚ,ㅙ","ㅚ,ㅞ","ㅙ,ㅞ",
      "ㅢ,ㅣ","ㅣ,ㅢ","ㅓ,ㅗ","ㅕ,ㅛ","ㅠ,ㅡ",
      "ㄴ,ㅇ","ㅇ,ㄴ","ㅂ,ㅍ","ㅍ,ㅂ","ㅂ,ㅁ","ㅁ,ㅂ",
      "ㄷ,ㅌ","ㅌ,ㄷ","ㅅ,ㅆ","ㅆ,ㅅ","ㅎ,"," ,ㅎ"
    ]).has(`${a},${b}`);
  }

  // 징검다리 매칭: targetJ 의 각 자모를 순서대로, heardJ 의 앞으로 제한된 창(window) 안에서 찾으며 전진
  function steppingCoverage(targetJ, heardJ, opts={}){
    const windowSize = Math.max(1, Math.min(30, opts.windowSize ?? 6));   // 창 크기(앞으로 몇 자모까지 허용)
    const jumpLimit  = Math.max(1, Math.min(30, opts.jumpLimit  ?? 8));   // 한 번에 칠할 수 있는 최대 증가분(점프 제한)
    const tailGraceP = Math.max(0,  Math.min(0.2, opts.tailGraceP ?? 0.06)); // 끝부분 관대비율

    const n = targetJ.length, m = heardJ.length;
    if (DEBUG) {
      dbg("─".repeat(40));
      dbg("STEP start n/m:", n, "/", m, "win:", windowSize, "jump:", jumpLimit, "tailP:", tailGraceP);
      dbg("targetJ:", targetJ.slice(0,120) + (n>120?"…":""));
      dbg("heardJ :", heardJ.slice(0,120) + (m>120?"…":""));
    }

    let i = 0, j = 0;  // i: target index, j: heard index (둘 다 전진만)
    let matched=0, skipped=0;

    while (i < n && j < m){
      let found = -1;
      const end = Math.min(m, j + windowSize);
      for (let jj = j; jj < end; jj++){
        if (near(targetJ[i], heardJ[jj])) { found = jj; break; }
      }
      if (found >= 0){
        matched++;
        if (DEBUG) dbg(`✔ match i=${i}(${targetJ[i]}) @ heard[${found}]=${heardJ[found]}  (j→${found+1})`);
        i++; j = found + 1;  // 둘 다 앞으로
      } else {
        skipped++;
        if (DEBUG) dbg(`… skip i=${i}(${targetJ[i]}) (발음누락 보정)`);
        i++;                 // 발음 누락으로 보고 target 만 전진(heard 는 그대로)
      }
      if (matched+skipped>800){ // 안전장치
        if (DEBUG) dbg("⚠ loop break safety");
        break;
      }
    }

    let k = i; // 이론상 읽어낸 접두 길이
    const beforeLimit = k;
    // 너무 빨리 색칠되지 않도록 기존 그려진 위치(state.paintedPrefix) 기준 점프 제한
    if (typeof state?.paintedPrefix === "number") {
      k = Math.min(k, state.paintedPrefix + jumpLimit, n);
    } else {
      k = Math.min(k, n);
    }

    // 끝부분 관대함: target 끝에서 일부 자모는 오인식/누락 허용
    const tailGrace = Math.max(4, Math.floor(n * tailGraceP));
    const done = (k >= n) || (k >= n - tailGrace);

    if (DEBUG) {
      dbg(`result matched=${matched} skipped=${skipped}  k=${k} (raw=${beforeLimit}) tailGrace=${tailGrace} done=${done}`);
    }
    return { k, done };
  }

  // ---------- SpeechRecognition (Android 최적화 루프) ----------
  function supportsSR(){ return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  function makeRecognizer(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = 'ko-KR';
    r.continuous = !IS_ANDROID;                     // 안드로이드는 false가 안정
    r.interimResults = !IS_ANDROID ? true : false;  // 안드로이드는 final 위주
    try { r.maxAlternatives = 4; } catch(_) {}
    return r;
  }

  let loopTimer=null;

  // 타이밍
  const ANDROID_WATCHDOG_MS  = 8500;
  const ANDROID_NORESULT_MS  = 7000; // 6000 → 7000

  let watchdogTimer = null;
  let noResultTimer = null;
  let lastStartTs   = 0;
  let lastResultTs  = 0;

  function runRecognizerLoop(){
    if (!state.listening) return;
    const recog = makeRecognizer();
    if (!recog) {
      els.listenHint && (els.listenHint.innerHTML="⚠️ 음성인식 미지원(Chrome/Safari 권장)");
      alert("이 브라우저는 음성인식을 지원하지 않습니다.");
      stopListening();
      return;
    }
    state.recog = recog;

    // onresult — 징검다리 매칭 + 글자색만 변경 + 140ms 지연 칠하기 + 자연스러운 다음 절 이동
    recog.onresult = (evt)=>{
      lastResultTs = Date.now();
      if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer = null; }
      noResultTimer = setTimeout(() => {
        if (!state.listening) return;
        try { state.recog && state.recog.abort?.(); } catch(_) {}
        runRecognizerLoop();
      }, ANDROID_NORESULT_MS);

      const v = state.verses[state.currentVerseIdx] || "";
      if (!v) return;
      if (Date.now() < state.ignoreUntilTs) return;

      const res = evt.results[evt.results.length-1]; if (!res) return;
      const tr = res[0]?.transcript || ""; if (!tr) return;

      const targetJ = state.targetJ || normalizeToJamo(v, false);
      const pieceJ  = normalizeToJamo(tr, true);

      // 누적
      if (res.isFinal || IS_ANDROID) {
        state.heardJ = (state.heardJ + pieceJ);
        const cap = targetJ.length * 3;
        if (state.heardJ.length > cap) state.heardJ = state.heardJ.slice(-cap);
      }

      const tmpHeard = state.heardJ + (res.isFinal ? "" : pieceJ);

      // 디버그 로그(입력)
      dbg("final?", !!res.isFinal, "tr:", tr);
      dbg("pieceJ:", pieceJ);
      dbg("tmpHeard.len:", (tmpHeard||"").length);

      // 징검다리 매칭으로 접두 길이 k 계산
      const { k, done } = steppingCoverage(targetJ, tmpHeard, {
        windowSize: 6,    // 필요시 튜닝
        jumpLimit : 8,    // 프레임당 최대 증가 자모수
        tailGraceP: 0.06  // 끝부분 관대 비율
      });

      // 디버그 로그(산출)
      dbg("paint from", state.paintedPrefix, "→", k, "done?", done);

      // 색칠(살짝 지연)
      schedulePaint(k);

      // 모두(또는 거의) 칠해졌으면 자동으로 다음 절
      const fullyPainted = Math.max(state.paintedPrefix, state.pendingPaint, k) >= targetJ.length;
      if (!state._advancing && (done || fullyPainted)) {
        state._advancing = true;
        setTimeout(() => {
          completeVerse(true); // 무조건 다음 절
          state._advancing = false;
        }, 100);
        return;
      }
    };

    const restart = () => {
      if (!state.listening) return;
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer=null; }
      if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer=null; }
      try {
        if (state.recog) {
          state.recog.onresult=null; state.recog.onend=null; state.recog.onerror=null;
          state.recog.abort?.();
        }
      } catch(_) {}
      loopTimer = setTimeout(runRecognizerLoop, 200);
    };
    recog.onend = restart;

    recog.onerror = (e)=>{
      const err = e?.error || "";
      if (err === "aborted" || err === "no-speech") {
        if (!state.listening) return;
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer=null; }
        if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer=null; }
        loopTimer = setTimeout(runRecognizerLoop, 300);
        return;
      }
      console.warn("[SR] error:", err, e);
      if (!state.listening) return;
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer=null; }
      if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer=null; }
      loopTimer = setTimeout(runRecognizerLoop, 400);
      if (err === "not-allowed" || err === "service-not-allowed") {
        alert("마이크 권한이 필요합니다. 주소창 오른쪽 마이크 아이콘을 확인하세요.");
      }
    };

    try {
      lastStartTs  = Date.now();
      lastResultTs = lastStartTs;

      if (watchdogTimer) { clearTimeout(watchdogTimer); }
      watchdogTimer = setTimeout(() => {
        if (!state.listening) return;
        if (lastResultTs === lastStartTs) {
          try { state.recog && state.recog.abort?.(); } catch(_) {}
          runRecognizerLoop();
        }
      }, ANDROID_WATCHDOG_MS);

      if (noResultTimer) { clearTimeout(noResultTimer); }
      noResultTimer = setTimeout(() => {
        if (!state.listening) return;
        try { state.recog && state.recog.abort?.(); } catch(_) {}
        runRecognizerLoop();
      }, ANDROID_NORESULT_MS);

      recog.start();
    } catch(e) {
      console.warn("recog.start 실패:", e);
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer=null; }
      if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer=null; }
      loopTimer = setTimeout(runRecognizerLoop, 150);
    }
  }

  async function startListening(showAlert=true){
    if (state.listening) return;
    if (!supportsSR()){
      els.listenHint && (els.listenHint.innerHTML="⚠️ 음성인식 미지원(Chrome/Safari 권장)");
      if (showAlert) alert("이 브라우저는 음성인식을 지원하지 않습니다.");
      return;
    }
    await primeMicrophone(); // 권한/경로 고정

    state.paintedPrefix = 0;
    state.heardJ = "";            // 시작 시 버퍼 초기화
    state.ignoreUntilTs = 0;
    state._advancing = false;
    if (state.paintTimer) { clearTimeout(state.paintTimer); state.paintTimer=null; }
    state.listening = true;
    els.btnToggleMic && (els.btnToggleMic.textContent="⏹️");
    startMicLevel();

    refreshRecogModeLock(); // 라디오 잠금(없으면 무시)
    runRecognizerLoop();
  }

  function stopListening(resetBtn=true){
    state.listening=false;
    if (loopTimer) { clearTimeout(loopTimer); loopTimer=null; }
    if (state.recog){
      try{ state.recog.onresult=null; state.recog.onend=null; state.recog.onerror=null; state.recog.abort?.(); }catch(_){}
      try{ state.recog.stop?.(); }catch(_){}
    }
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer=null; }
    if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer=null; }
    if (state.paintTimer) { clearTimeout(state.paintTimer); state.paintTimer=null; }

    if (resetBtn && els.btnToggleMic) els.btnToggleMic.textContent="🎙️";
    stopMicLevel();
    releasePrimeMic();
    refreshRecogModeLock(); // 라디오 잠금 해제(없으면 무시)
  }

  // 마이크 버튼으로만 제어
  els.btnToggleMic?.addEventListener("click", ()=>{ if(!state.listening) startListening(); else stopListening(); });

  // ---------- 완료/자동이동 ----------
  async function advanceToNextVerse() {
    if (state.currentVerseIdx < state.verses.length - 1) {
      state.currentVerseIdx++;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      buildVerseGrid();   // 절 버튼 active/완료 반영
      return true;
    }
    return false;
  }

  // ✅ 변경: force=true면 자동이동 체크박스 무시하고 이동
  async function completeVerse(force=false){
    await incVersesRead(1);
    markVerseAsDone(state.currentVerseIdx + 1);

    const auto = force ? true : (els.autoAdvance ? !!els.autoAdvance.checked : true);
    const b = getBookByKo(state.currentBookKo);

    if (auto){
      const moved = await advanceToNextVerse();
      if (!moved){
        await markChapterDone(b.id, state.currentChapter);

        if (state.currentChapter < b.ch) {
          const next = state.currentChapter + 1;
          await selectChapter(next);
          buildChapterGrid();
          state.paintedPrefix = 0;
          state.heardJ = "";               // 다음 장으로 넘어가면 버퍼 초기화
          state.ignoreUntilTs = Date.now() + 600;
        } else {
          alert("이 권의 모든 장을 완료했습니다. 다른 권을 선택하세요.");
        }
        return;
      }
      state.paintedPrefix = 0;
      state.heardJ = "";                   // 다음 절로 넘어가면 버퍼 초기화
      state.ignoreUntilTs = Date.now() + 500;
    } else {
      state.ignoreUntilTs = Date.now() + 300;
    }
  }

  // ---------- 앞/뒤 절 버튼 ----------
  els.btnNextVerse?.addEventListener("click", ()=>{
    if(!state.verses.length) return;
    if(state.currentVerseIdx<state.verses.length-1){
      state.currentVerseIdx++;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      buildVerseGrid();
      state.paintedPrefix=0; state.heardJ=""; state.ignoreUntilTs = Date.now() + 300; // 버퍼 초기화
    }
  });
  els.btnPrevVerse?.addEventListener("click", ()=>{
    if(!state.verses.length) return;
    if(state.currentVerseIdx>0){
      state.currentVerseIdx--;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      buildVerseGrid();
      state.paintedPrefix=0; state.heardJ=""; state.ignoreUntilTs = Date.now() + 300; // 버퍼 초기화
    }
  });

  // "해당절읽음" 버튼
  els.btnMarkRead?.addEventListener("click", async () => {
    if (!state.verses.length) return;

    await incVersesRead(1);
    markVerseAsDone(state.currentVerseIdx + 1);

    if (state.currentVerseIdx < state.verses.length - 1) {
      state.currentVerseIdx++;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      buildVerseGrid();
      state.paintedPrefix = 0;
      state.heardJ = "";                 // 버퍼 초기화
      state.ignoreUntilTs = Date.now() + 500;
      return;
    }

    const b = getBookByKo(state.currentBookKo);
    await markChapterDone(b.id, state.currentChapter);
    state.myStats.last.verse = 0;
    state.myStats.last.chapter = state.currentChapter;
    saveLastPosition();

    if (state.currentChapter < b.ch) {
      const nextChapter = state.currentChapter + 1;
      await selectChapter(nextChapter);
      buildChapterGrid();
      state.paintedPrefix = 0;
      state.heardJ = "";               // 버퍼 초기화
      state.ignoreUntilTs = Date.now() + 600;
    } else {
      alert("이 권의 모든 장을 완료했습니다. 다른 권을 선택하세요.");
    }
  });

  // ---------- 음성모드 라디오: 마이크 ON일 때 변경 금지 ----------
  function refreshRecogModeLock() {
    const radios = document.querySelectorAll('input[name=recogMode]');
    if (!radios?.length) return;
    radios.forEach(r => { r.disabled = state.listening; });
  }
  document.querySelectorAll('input[name=recogMode]')?.forEach(radio=>{
    radio.addEventListener('change', (e)=>{
      if (state.listening) {
        e.preventDefault();
        e.stopImmediatePropagation();
        alert("마이크를 끈 후에 음성 인식 모드를 변경할 수 있습니다.");
        refreshRecogModeLock();
      }
    });
  });

  // ---------- Leaderboard ----------
  async function loadLeaderboard() {
    if (!db || !els.leaderList) return;
    let qs; try { qs = await db.collection("users").orderBy("versesRead","desc").limit(20).get(); } catch (e) { return; }
    const list=[]; qs.forEach(doc=>list.push({id:doc.id, ...doc.data()}));
    els.leaderList.innerHTML="";
    list.forEach((u,idx)=>{
      const label = (u.nickname && String(u.nickname).trim())
        ? String(u.nickname).trim()
        : ((u.email || "").toString().split("@")[0] || `user-${String(u.id).slice(0,6)}`);
      const v = Number(u.versesRead||0), c = Number(u.chaptersRead||0);
      const li=document.createElement("li");
      li.innerHTML = `<strong>${idx+1}위</strong> ${label} · 절 ${v.toLocaleString()} · 장 ${c.toLocaleString()}`;
      els.leaderList.appendChild(li);
    });
  }

  // (도움) 성경 축약표기
  function shortBookName(b){
    return b.abbr || b.short || (b.ko ? b.ko.slice(0,2) : b.id || "");
  }

  // ---------- Progress Matrix ----------
  function buildMatrix() {
    if (!els.matrixWrap) return;
    const maxCh = Math.max(...BOOKS.map(b => b.ch));

    const table = document.createElement("table");
    table.className = "matrix";

    const thead = document.createElement("thead");

    // 3행 헤더
    const trTop    = document.createElement("tr");
    const trMiddle = document.createElement("tr");
    const trBottom = document.createElement("tr");

    const thBook = document.createElement("th");
    thBook.className = "book";
    thBook.textContent = "권/장";
    thBook.rowSpan = 3;
    trTop.appendChild(thBook);

    for (let c = 1; c <= maxCh; c++) {
      const hundreds = Math.floor(c / 100);
      const tens     = Math.floor((c % 100) / 10);
      const ones     = c % 10;

      const thH = document.createElement("th");
      thH.textContent = hundreds || "";
      const thT = document.createElement("th");
      thT.textContent = tens || "";
      const thO = document.createElement("th");
      thO.textContent = ones;

      [thH, thT, thO].forEach(th => {
        th.style.textAlign = "center";
        th.style.minWidth = "20px";
        th.style.width = "20px";
      });

      trTop.appendChild(thH);
      trMiddle.appendChild(thT);
      trBottom.appendChild(thO);
    }

    thead.appendChild(trTop);
    thead.appendChild(trMiddle);
    thead.appendChild(trBottom);
    table.appendChild(thead);

    // 본문
    const tbody = document.createElement("tbody");
    for (const b of BOOKS) {
      const tr = document.createElement("tr");

      const th = document.createElement("th");
      th.className = "book";
      th.textContent = shortBookName(b);
      tr.appendChild(th);

      const read = state.progress[b.id]?.readChapters || new Set();
      for (let c = 1; c <= maxCh; c++) {
        const td = document.createElement("td");
        if (c <= b.ch) {
          td.textContent = " ";
          td.style.background = read.has(c)
            ? "rgba(67,209,122,0.6)"
            : "rgba(120,120,140,0.25)";
          td.title = `${b.ko} ${c}장`;
        } else {
          td.style.background = "transparent";
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    els.matrixWrap.innerHTML = "";
    els.matrixWrap.appendChild(table);
  }

  function openMatrix(){
    buildMatrix();
    if (els.matrixModal){
      els.matrixModal.style.pointerEvents = "auto";
    }
    els.matrixModal?.classList.add("show");
    els.matrixModal?.classList.remove("hidden");
  }

  function closeMatrix(){
    els.matrixModal?.classList.remove("show");
    els.matrixModal?.classList.add("hidden");
    if (els.matrixModal){
      els.matrixModal.style.pointerEvents = "none";
    }
  }

  document.getElementById("btnOpenMatrix")?.addEventListener("click", openMatrix);
  els.btnCloseMatrix?.addEventListener("click", (e)=>{ e?.preventDefault?.(); e?.stopPropagation?.(); closeMatrix(); });
  els.matrixModal?.addEventListener("click", (e)=>{ const body=els.matrixModal.querySelector(".modal-body"); if (!body || !e.target) return; if (!body.contains(e.target)) closeMatrix(); });
  window.addEventListener("keydown", (e)=>{ if (e.key==='Escape' && els.matrixModal?.classList.contains('show')) closeMatrix(); });

  // ---------- Mic Level Meter ----------
  let audioCtx, analyser, micSrc, levelTimer, micStream;
  async function startMicLevel() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      micSrc = audioCtx.createMediaStreamSource(micStream);
      micSrc.connect(analyser);

      const dataArray = new Uint8Array(analyser.fftSize);

      function update() {
        if (!analyser) return;
        analyser.getByteTimeDomainData(dataArray);
        let sumSq = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / dataArray.length);
        const db = 20 * Math.log10(rms || 1e-6);
        if (els.micBar) els.micBar.style.width = Math.min(100, Math.max(0, rms * 400)) + "%";
        if (els.micDb) els.micDb.textContent = (db <= -60 ? "-∞" : db.toFixed(0)) + " dB";
        levelTimer = requestAnimationFrame(update);
      }
      update();
    } catch (e) {
      console.warn("[MicLevel] 마이크 접근 실패:", e);
    }
  }
  function stopMicLevel() {
    if (levelTimer) cancelAnimationFrame(levelTimer);
    levelTimer = null;
    if (audioCtx) { try { audioCtx.close(); } catch(_) {} }
    if (micStream) { try { micStream.getTracks().forEach(t=>t.stop()); } catch(_) {} }
    audioCtx = null; analyser = null; micSrc = null; micStream = null;
    if (els.micBar) els.micBar.style.width = "0%";
    if (els.micDb) els.micDb.textContent = "-∞ dB";
  }

  // ---------- 장 선택 ----------
  async function selectChapter(chapter) {
    state.currentChapter = chapter;
    state.currentVerseIdx = 0;

    const b = getBookByKo(state.currentBookKo);
    els.locLabel && (els.locLabel.textContent = `${b?.ko || ""} ${chapter}장`);
    els.verseText && (els.verseText.textContent = "로딩 중…");

    if (!state.bible) {
      await loadBible();
      if (!state.bible) {
        els.verseText && (els.verseText.textContent = "bible.json 로딩 실패");
        return;
      }
    }

    // bible.json: 책명(ko) → 장(String) → {절:String}
    const chObj = state.bible?.[state.currentBookKo]?.[String(chapter)];
    if (!chObj) {
      els.verseText && (els.verseText.textContent = `${b?.ko || ""} ${chapter}장 본문 없음`);
      els.verseCount && (els.verseCount.textContent = "");
      els.verseGrid && (els.verseGrid.innerHTML = "");
      return;
    }

    const entries = Object.entries(chObj)
      .map(([k,v])=>[parseInt(k,10), String(v)])
      .sort((a,c)=>a[0]-c[0]);

    state.verses = entries.map(e=>e[1]);

    els.verseCount && (els.verseCount.textContent = `(${state.verses.length}절)`);
    buildVerseGrid();
    updateVerseText();

    state.myStats.last = { bookKo: state.currentBookKo, chapter, verse: 1 };
    saveLastPosition();

    buildChapterGrid(); // 현재 장 active/done 반영 갱신
  }

})();
