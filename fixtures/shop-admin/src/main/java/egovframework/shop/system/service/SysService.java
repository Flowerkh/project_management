package egovframework.shop.system.service;

import java.util.List;
import egovframework.rte.psl.dataaccess.util.EgovMap;

public interface SysService {
    Object selectMenuList(SysVO vo) throws Exception;
    Object insertMenu(SysVO vo) throws Exception;
    Object deleteMenu(SysVO vo) throws Exception;
    Object selectCodeList(SysVO vo) throws Exception;
    Object mergeCodeDetail(SysVO vo) throws Exception;
    Object selectAdminList(SysVO vo) throws Exception;
    Object updateAdminAuth(SysVO vo) throws Exception;
    Object selectLoginLogList(SysVO vo) throws Exception;
    Object selectDynamic(SysVO vo) throws Exception;
}
