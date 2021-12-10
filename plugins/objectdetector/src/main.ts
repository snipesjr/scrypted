import { MixinProvider, ScryptedDeviceType, ScryptedInterface, MediaObject, VideoCamera, Settings, Setting, Camera, EventListenerRegister, ObjectDetector, ObjectDetection, ScryptedDevice, ObjectDetectionResult, FaceRecognitionResult, ObjectDetectionTypes, ObjectsDetected, MotionSensor, MediaStreamOptions, MixinDeviceBase, ScryptedNativeId, DeviceState } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { SettingsMixinDeviceBase } from "../../../common/src/settings-mixin";
import { alertRecommendedPlugins } from '@scrypted/common/src/alert-recommended-plugins';
import { DenoisedDetectionEntry, denoiseDetections } from './denoise';
import { AutoenableMixinProvider } from "../../../common/src/autoenable-mixin-provider"

export interface DetectionInput {
  jpegBuffer?: Buffer;
  input: any;
}

const { mediaManager, systemManager, log } = sdk;

const defaultDetectionDuration = 60;
const defaultDetectionInterval = 60;
const defaultDetectionTimeout = 10;

class ObjectDetectionMixin extends SettingsMixinDeviceBase<VideoCamera & Camera & MotionSensor & ObjectDetector> implements ObjectDetector, Settings {
  released = false;
  motionListener: EventListenerRegister;
  detectionListener: EventListenerRegister;
  detections = new Map<string, DetectionInput>();
  cameraDevice: ScryptedDevice & Camera & VideoCamera & MotionSensor;
  detectionTimeout = parseInt(this.storage.getItem('detectionTimeout')) || defaultDetectionTimeout;
  detectionDuration = parseInt(this.storage.getItem('detectionDuration')) || defaultDetectionDuration;
  detectionInterval = parseInt(this.storage.getItem('detectionInterval')) || defaultDetectionInterval;
  detectionIntervalTimeout: NodeJS.Timeout;
  currentDetections: DenoisedDetectionEntry<ObjectDetectionResult>[] = [];
  currentPeople: DenoisedDetectionEntry<FaceRecognitionResult>[] = [];
  detectionId: string;
  running = false;
  hasMotionType: boolean;
  settings: Setting[];

  constructor(mixinDevice: VideoCamera & Settings, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: { [key: string]: any }, public objectDetectionPlugin: ObjectDetectorMixin, public objectDetection: ObjectDetection & ScryptedDevice) {
    super(mixinDevice, mixinDeviceState, {
      providerNativeId: objectDetectionPlugin.mixinProviderNativeId,
      mixinDeviceInterfaces,
      group: objectDetection.name,
      groupKey: "objectdetectionplugin:" + objectDetection.id,
      mixinStorageSuffix: objectDetection.id,
    });

    this.cameraDevice = systemManager.getDeviceById<Camera & VideoCamera & MotionSensor>(this.id);
    this.detectionId = 'objectdetection-' + this.cameraDevice.id;

    this.bindObjectDetection();
    this.register();
    this.resetDetectionTimeout();
  }

  clearDetectionTimeout() {
    clearTimeout(this.detectionIntervalTimeout);
    this.detectionIntervalTimeout = undefined;
  }

  resetDetectionTimeout() {
    this.clearDetectionTimeout();
    this.detectionIntervalTimeout = setInterval(() => {
      if (!this.running)
        this.snapshotDetection();
    }, this.detectionInterval * 1000);
  }

  async ensureSettings(): Promise<Setting[]> {
    if (this.hasMotionType !== undefined)
      return;
    this.hasMotionType = false;
    const model = await this.objectDetection.getDetectionModel();
    this.hasMotionType = model.classes.includes('motion');
    this.settings = model.settings;
  }

  async getCurrentSettings() {
    await this.ensureSettings();
    if (!this.settings)
      return;

    const ret: any = {};
    for (const setting of this.settings) {
      ret[setting.key] = this.storage.getItem(setting.key) || setting.value;
    }

    return ret;
  }

  async snapshotDetection() {
    await this.ensureSettings();

    if (this.hasMotionType) {
      await this.startVideoDetection();
      return;
    }

    const picture = await this.cameraDevice.takePicture();
    const detections = await this.objectDetection.detectObjects(picture, {
      detectionId: this.detectionId,
      settings: await this.getCurrentSettings(),
    });
    this.objectsDetected(detections);
  }

  bindObjectDetection() {
    this.running = false;
    this.detectionListener?.removeListener();
    this.detectionListener = undefined;
    this.objectDetection?.detectObjects(undefined, {
      detectionId: this.detectionId,
    });

    this.detectionListener = this.objectDetection.listen({
      event: ScryptedInterface.ObjectDetection,
      watch: false,
    }, (eventSource, eventDetails, eventData: ObjectsDetected) => {
      if (eventData?.detectionId !== this.detectionId)
        return;
      this.objectsDetected(eventData);
      this.reportObjectDetections(eventData, undefined);

      this.running = eventData.running;
    });

    this.snapshotDetection();
  }

  async register() {
    this.motionListener = this.cameraDevice.listen(ScryptedInterface.MotionSensor, async () => {
      if (!this.cameraDevice.motionDetected)
        return;

      await this.startVideoDetection();
    });
  }

  async startVideoDetection() {
    // prevent stream retrieval noise until notified that the detection is no logner running.
    if (this.running)
      return;
    this.running = true;

    try {
      let selectedStream: MediaStreamOptions;

      const streamingChannel = this.storage.getItem('streamingChannel');
      if (streamingChannel) {
        const msos = await this.cameraDevice.getVideoStreamOptions();
        selectedStream = msos.find(mso => mso.name === streamingChannel);
      }

      const session = await this.objectDetection?.detectObjects(await this.cameraDevice.getVideoStream(selectedStream), {
        detectionId: this.detectionId,
        duration: this.getDetectionDuration(),
        settings: await this.getCurrentSettings(),
      });

      this.running = session.running;
    }
    catch (e) {
      this.running = false;
    }
  }

  getDetectionDuration() {
    // when motion type, the detection interval is a keepalive reset.
    // the duration needs to simply be an arbitrarily longer time.
    return this.hasMotionType ? this.detectionInterval * 1000 * 5 : this.detectionDuration * 1000;
  }

  reportObjectDetections(detection: ObjectsDetected, detectionInput?: DetectionInput) {
    if (detectionInput)
      this.setDetection(this.detectionId, detectionInput);

    this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
  }

  async extendedObjectDetect() {
    try {
      await this.objectDetection?.detectObjects(undefined, {
        detectionId: this.detectionId,
        duration: this.getDetectionDuration(),
      });
    }
    catch (e) {
      // ignore any
    }
  }

  async objectsDetected(detectionResult: ObjectsDetected) {
    // do not denoise
    if (this.hasMotionType) {
      return;
    }

    if (!detectionResult?.detections) {
      // detection session ended.
      return;
    }

    const { detections } = detectionResult;

    const found: DenoisedDetectionEntry<ObjectDetectionResult>[] = [];
    denoiseDetections<ObjectDetectionResult>(this.currentDetections, detections.map(detection => ({
      id: detection.id,
      name: detection.className,
      detection,
    })), {
      timeout: this.detectionTimeout * 1000,
      added: d => found.push(d),
      removed: d => {
        this.console.log('expired detection:', `${d.detection.className} (${d.detection.score}, ${d.detection.id})`);
        if (detectionResult.running)
          this.extendedObjectDetect();
      }
    });
    if (found.length) {
      this.console.log('new detection:', found.map(d => `${d.detection.className} (${d.detection.score}, ${d.detection.id})`).join(', '));
      this.console.log('current detections:', this.currentDetections.map(d => `${d.detection.className} (${d.detection.score}, ${d.detection.id})`).join(', '));
      if (detectionResult.running)
        this.extendedObjectDetect();
    }
  }

  async peopleDetected(detectionResult: ObjectsDetected) {
    if (!detectionResult?.people) {
      return;
    }

    const found: DenoisedDetectionEntry<FaceRecognitionResult>[] = [];
    denoiseDetections<FaceRecognitionResult>(this.currentPeople, detectionResult.people.map(detection => ({
      id: detection.id,
      name: detection.label,
      detection,
    })), {
      timeout: this.detectionTimeout * 1000,
      added: d => found.push(d),
      removed: d => {
        this.console.log('expired detection:', `${d.detection.label} (${d.detection.score}, ${d.detection.id})`);
        if (detectionResult.running)
          this.extendedFaceDetect();
      }
    });
    if (found.length) {
      this.console.log('new detection:', found.map(d => `${d.detection.label} (${d.detection.score}, ${d.detection.id})`).join(', '));
      this.console.log('current detections:', this.currentDetections.map(d => `${d.detection.className} (${d.detection.score}, ${d.detection.id})`).join(', '));
      this.extendedFaceDetect();
    }
  }

  async extendedFaceDetect() {
    this.objectDetection?.detectObjects(undefined, {
      detectionId: this.detectionId,
      duration: 60000,
    });
  }

  setDetection(detectionId: string, detectionInput: DetectionInput) {
    // this.detections.set(detectionId, detectionInput);
    // setTimeout(() => {
    //   this.detections.delete(detectionId);
    //   detectionInput?.input?.dispose();
    // }, DISPOSE_TIMEOUT);
  }

  async getNativeObjectTypes(): Promise<ObjectDetectionTypes> {
    if (this.mixinDeviceInterfaces.includes(ScryptedInterface.ObjectDetector))
      return this.mixinDevice.getObjectTypes();
    return {};
  }

  async getObjectTypes(): Promise<ObjectDetectionTypes> {
    return this.objectDetection.getDetectionModel();
  }

  async getDetectionInput(detectionId: any): Promise<MediaObject> {
    const detection = this.detections.get(detectionId);
    if (!detection) {
      if (this.mixinDeviceInterfaces.includes(ScryptedInterface.ObjectDetector))
        return this.mixinDevice.getDetectionInput(detectionId);
      return;
    }
    // if (!detection.jpegBuffer) {
    //   detection.jpegBuffer = Buffer.from(await encodeJpeg(detection.input));
    // }
    return mediaManager.createMediaObject(detection.jpegBuffer, 'image/jpeg');
  }

  async getMixinSettings(): Promise<Setting[]> {
    const settings: Setting[] = [];

    let msos: MediaStreamOptions[] = [];
    try {
      msos = await this.cameraDevice.getVideoStreamOptions();
    }
    catch (e) {
    }

    if (msos?.length) {
      settings.push({
        title: 'Video Stream',
        key: 'streamingChannel',
        value: this.storage.getItem('streamingChannel') || msos[0].name,
        description: 'The media stream to analyze.',
        choices: msos.map(mso => mso.name),
      });
    }

    if (!this.hasMotionType) {
      settings.push(
        {
          title: 'Detection Duration',
          description: 'The duration in seconds to analyze video when motion occurs.',
          key: 'detectionDuration',
          type: 'number',
          value: this.detectionDuration.toString(),
        },
        {
          title: 'Idle Detection Interval',
          description: 'The interval in seconds to analyze snapshots when there is no motion.',
          key: 'detectionInterval',
          type: 'number',
          value: this.detectionInterval.toString(),
        },
        {
          title: 'Detection Timeout',
          description: 'Timeout in seconds before removing an object that is no longer detected.',
          key: 'detectionTimeout',
          type: 'number',
          value: this.detectionTimeout.toString(),
        },
      )
    }

    if (this.settings) {
      settings.push(...this.settings.map(setting =>
        Object.assign({}, setting, {
          value: this.storage.getItem(setting.key) || setting.value,
        } as Setting))
      );
    }

    return settings;
  }

  async putMixinSetting(key: string, value: string | number | boolean): Promise<void> {
    const vs = value.toString();
    this.storage.setItem(key, vs);
    if (key === 'detectionDuration') {
      this.detectionDuration = parseInt(vs) || defaultDetectionDuration;
    }
    else if (key === 'detectionInterval') {
      this.detectionInterval = parseInt(vs) || defaultDetectionInterval;
      this.resetDetectionTimeout();
    }
    else if (key === 'detectionTimeout') {
      this.detectionTimeout = parseInt(vs) || defaultDetectionTimeout;
    }
    else if (key === 'streamingChannel') {
      this.bindObjectDetection();
    }
    else {
      const settings = await this.getCurrentSettings();
      if (settings && settings[key]) {
        settings[key] = value;
      }
      this.bindObjectDetection();
    }
  }

  release() {
    super.release();
    this.released = true;
    this.clearDetectionTimeout();
    this.motionListener?.removeListener();
    this.detectionListener?.removeListener();
    this.objectDetection?.detectObjects(undefined, {
      detectionId: this.detectionId,
    });
  }
}

class ObjectDetectorMixin extends MixinDeviceBase<ObjectDetection> implements MixinProvider {
  constructor(mixinDevice: ObjectDetection, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: DeviceState, mixinProviderNativeId: ScryptedNativeId) {
    super(mixinDevice, mixinDeviceInterfaces, mixinDeviceState, mixinProviderNativeId);

    // trigger mixin creation. todo: fix this to not be stupid hack.
    for (const id of Object.keys(systemManager.getSystemState())) {
      const device = systemManager.getDeviceById<VideoCamera & Settings>(id);
      if (!device.mixins?.includes(this.id))
        continue;
      device.probe();

    }
  }

  async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
    if ((interfaces.includes(ScryptedInterface.VideoCamera) || interfaces.includes(ScryptedInterface.Camera))
      && interfaces.includes(ScryptedInterface.MotionSensor)) {
      return [ScryptedInterface.ObjectDetector, ScryptedInterface.MotionSensor, ScryptedInterface.Settings];
    }
    return null;
  }

  async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: { [key: string]: any }) {
    return new ObjectDetectionMixin(mixinDevice, mixinDeviceInterfaces, mixinDeviceState, this, systemManager.getDeviceById<ObjectDetection>(this.id));
  }

  async releaseMixin(id: string, mixinDevice: any) {
    mixinDevice.release();
  }
}

class ObjectDetectionPlugin extends AutoenableMixinProvider {
  constructor(nativeId?: ScryptedNativeId) {
    super(nativeId);

    alertRecommendedPlugins({
      '@scrypted/opencv': "OpenCV Motion Detection Plugin",
      '@scrypted/tensorflow': 'TensorFlow Face Recognition Plugin',
      '@scrypted/tensorflow-lite': 'TensorFlow Lite Object Detection Plugin',
    });
  }

  async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
    if (!interfaces.includes(ScryptedInterface.ObjectDetection))
      return;
    return [ScryptedInterface.MixinProvider];
  }

  async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: { [key: string]: any; }): Promise<any> {
    return new ObjectDetectorMixin(mixinDevice, mixinDeviceInterfaces, mixinDeviceState, this.nativeId);
  }

  async releaseMixin(id: string, mixinDevice: any): Promise<void> {
    // what does this mean to make a mixin provider no longer available?
    // just ignore it until reboot?
  }
}

export default new ObjectDetectionPlugin();
