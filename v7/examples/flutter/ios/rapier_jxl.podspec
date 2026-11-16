Pod::Spec.new do |s|
  s.name = 'rapier_jxl'
  s.version = '0.1.0'
  s.summary = "Reads a video's frames with AVFoundation for rapier_jxl."
  s.homepage = 'https://rapier.website'
  s.license = { :type => 'MIT' }
  s.author = 'rapier.website'
  s.source = { :path => '.' }
  s.source_files = 'Classes/**/*'
  s.dependency 'Flutter'
  s.platform = :ios, '15.1'
  s.swift_version = '5.0'
  s.frameworks = 'AVFoundation', 'Accelerate'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
end
