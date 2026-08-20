# Homebrew formula (tap-ready draft).
#
# To publish: create a tap repo (github.com/kwicz/homebrew-tap), copy this
# file into Formula/, tag a release of image-luminescence (e.g. v1.0.0),
# then fill in the tarball sha256:
#   curl -L https://github.com/kwicz/image-luminescence/archive/refs/tags/v1.0.0.tar.gz | shasum -a 256
# Users then run:
#   brew tap kwicz/tap && brew install image-luminescence
class ImageLuminescence < Formula
  desc "Make images glow on HDR displays; colors preserved exactly"
  homepage "https://kwicz.github.io/image-luminescence/"
  url "https://github.com/kwicz/image-luminescence/archive/refs/tags/v1.1.0.tar.gz"
  sha256 "dce20d43842936040ba0e804675c8ff63752988e7804ffc637c6396484103581"
  license "MIT"

  depends_on "imagemagick"
  depends_on "libultrahdr"
  depends_on "numpy"

  def install
    libexec.install "luminescence.py", "luminescence_pq.py",
                    "luminescence_reveal.py", "luminescence_icc.py",
                    "rec2020-pq-reference.icc"
    # Pick whichever Homebrew python can import numpy, at run time, so
    # the shims survive python@3.x version bumps.
    finder = <<~SH
      #!/bin/bash
      for py in "#{HOMEBREW_PREFIX}"/opt/python@3*/bin/python3* "#{HOMEBREW_PREFIX}"/bin/python3 /usr/bin/python3; do
        [ -x "$py" ] || continue
        if "$py" -c "import numpy" >/dev/null 2>&1; then
          exec "$py" "#{libexec}/SCRIPT" "$@"
        fi
      done
      echo "luminesce: no python3 with numpy found (try: brew install numpy)" >&2
      exit 1
    SH
    (bin/"luminesce").write finder.sub("SCRIPT", "luminescence.py")
    (bin/"luminesce-pq").write finder.sub("SCRIPT", "luminescence_pq.py")
    (bin/"luminesce-reveal").write finder.sub("SCRIPT", "luminescence_reveal.py")
  end

  test do
    system "magick", "-size", "8x8", "xc:white", "#{testpath}/w.png"
    system bin/"luminesce", "#{testpath}/w.png"
    assert_path_exists "#{testpath}/w-luminescence.jpg"
  end
end
