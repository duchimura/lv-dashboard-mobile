window.addEventListener("load", function () {
  setTimeout(function () {
    var tw = document.querySelector(
      "iframe.twitter-tweet-rendered, iframe.twitter-tweet, .twitter-tweet"
    );
    if (!tw) return;
    var vw = window.innerWidth - 40;
    var vh = window.innerHeight - 40;
    var w = tw.offsetWidth || 550;
    var h = tw.offsetHeight || 400;
    var z = Math.min(1.6, vw / w, vh / h);
    if (z !== 1) tw.style.zoom = z;
  }, 1500);
});
