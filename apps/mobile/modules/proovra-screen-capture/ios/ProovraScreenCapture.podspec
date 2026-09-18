require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ProovraScreenCapture'
  s.version        = package['version'] || '1.0.0'
  s.summary        = 'PROOVRA UC-5 iOS native screen capture (ReplayKit system broadcast).'
  s.description    = 'Main-app side of the PROOVRA iOS direct screen-capture pipeline: presents Apple’s system broadcast picker and reads ORIGINAL segments a Broadcast Upload Extension writes to the shared App Group container.'
  s.author         = 'PROOVRA'
  s.homepage       = 'https://proovra.com'
  s.platforms      = { :ios => '13.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '*.{h,m,mm,swift,hpp,cpp}'
end
